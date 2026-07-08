const droidAccountService = require('../account/droidAccountService')
const accountGroupService = require('../accountGroupService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  isTruthy,
  isAccountHealthy,
  selectAccountBySchedulingWeight,
  normalizeEndpointType
} = require('../../utils/commonHelper')

class DroidScheduler {
  constructor() {
    this.STICKY_PREFIX = 'droid'
  }

  _isAccountSchedulable(account) {
    return isTruthy(account?.schedulable ?? true)
  }

  _matchesEndpoint(account, endpointType) {
    const normalizedEndpoint = normalizeEndpointType(endpointType)
    const accountEndpoint = normalizeEndpointType(account?.endpointType)
    if (normalizedEndpoint === accountEndpoint) {
      return true
    }
    if (normalizedEndpoint === 'comm') {
      return true
    }
    const sharedEndpoints = new Set(['anthropic', 'openai'])
    return sharedEndpoints.has(normalizedEndpoint) && sharedEndpoints.has(accountEndpoint)
  }

  _composeStickySessionKey(endpointType, sessionHash, apiKeyId) {
    if (!sessionHash) {
      return null
    }
    const normalizedEndpoint = normalizeEndpointType(endpointType)
    const apiKeyPart = apiKeyId || 'default'
    return `${this.STICKY_PREFIX}:${normalizedEndpoint}:${apiKeyPart}:${sessionHash}`
  }

  async _loadGroupAccounts(groupId) {
    const memberIds = await accountGroupService.getGroupMembers(groupId)
    if (!memberIds || memberIds.length === 0) {
      return []
    }

    const accounts = await Promise.all(
      memberIds.map(async (memberId) => {
        try {
          return await droidAccountService.getAccount(memberId)
        } catch (error) {
          logger.warn(`⚠️ 获取 Droid 分组成员账号失败: ${memberId}`, error)
          return null
        }
      })
    )

    const result = []
    for (const account of accounts) {
      if (!account || !isAccountHealthy(account) || !this._isAccountSchedulable(account)) {
        continue
      }
      const isTempUnavailable = await upstreamErrorHelper.isTempUnavailable(account.id, 'droid')
      if (isTempUnavailable) {
        logger.debug(
          `⏭️ Skipping Droid group member ${account.name || account.id} - temporarily unavailable`
        )
        continue
      }
      result.push(account)
    }
    return result
  }

  async _ensureLastUsedUpdated(accountId) {
    try {
      await droidAccountService.touchLastUsedAt(accountId)
    } catch (error) {
      logger.warn(`⚠️ 更新 Droid 账号最后使用时间失败: ${accountId}`, error)
    }
  }

  async _cleanupStickyMapping(stickyKey) {
    if (!stickyKey) {
      return
    }
    try {
      await redis.deleteSessionAccountMapping(stickyKey)
    } catch (error) {
      logger.warn(`⚠️ 清理 Droid 粘性会话映射失败: ${stickyKey}`, error)
    }
  }

  async selectAccount(apiKeyData, endpointType, sessionHash) {
    const normalizedEndpoint = normalizeEndpointType(endpointType)
    const stickyKey = this._composeStickySessionKey(normalizedEndpoint, sessionHash, apiKeyData?.id)

    let candidates = []
    let isDedicatedBinding = false

    if (apiKeyData?.droidAccountId) {
      const binding = apiKeyData.droidAccountId
      if (binding.startsWith('group:')) {
        const groupId = binding.substring('group:'.length)
        logger.info(
          `🤖 API Key ${apiKeyData.name || apiKeyData.id} 绑定 Droid 分组 ${groupId}，按分组调度`
        )
        candidates = await this._loadGroupAccounts(groupId, normalizedEndpoint)
      } else {
        const account = await droidAccountService.getAccount(binding)
        if (account) {
          const isTempUnavailable = await upstreamErrorHelper.isTempUnavailable(account.id, 'droid')
          if (isTempUnavailable) {
            logger.warn(
              `⏱️ Bound Droid account ${account.name || account.id} temporarily unavailable, falling back to pool`
            )
          } else {
            candidates = [account]
            isDedicatedBinding = true
          }
        }
      }
    }

    if (!candidates || candidates.length === 0) {
      candidates = await droidAccountService.getSchedulableAccounts(normalizedEndpoint)
    }

    const syncFiltered = candidates.filter(
      (account) =>
        account &&
        isAccountHealthy(account) &&
        this._isAccountSchedulable(account) &&
        this._matchesEndpoint(account, normalizedEndpoint)
    )
    const filteredResults = await Promise.all(
      syncFiltered.map(async (account) => {
        const isTempUnavailable = await upstreamErrorHelper.isTempUnavailable(account.id, 'droid')
        if (isTempUnavailable) {
          logger.debug(
            `⏭️ Skipping Droid account ${account.name || account.id} - temporarily unavailable`
          )
          return null
        }
        return account
      })
    )
    const filtered = filteredResults.filter(Boolean)

    if (filtered.length === 0) {
      throw new Error(
        `No available accounts for endpoint ${normalizedEndpoint}${apiKeyData?.droidAccountId ? ' (respecting binding)' : ''}`
      )
    }

    if (stickyKey && !isDedicatedBinding) {
      const mappedAccountId = await redis.getSessionAccountMapping(stickyKey)
      if (mappedAccountId) {
        const mappedAccount = filtered.find((account) => account.id === mappedAccountId)
        if (mappedAccount) {
          await redis.extendSessionAccountMappingTTL(stickyKey)
          logger.info(
            `🤖 命中 Droid 粘性会话: ${sessionHash} -> ${mappedAccount.name || mappedAccount.id}`
          )
          await this._ensureLastUsedUpdated(mappedAccount.id)
          return mappedAccount
        }

        await this._cleanupStickyMapping(stickyKey)
      }
    }

    const selected = selectAccountBySchedulingWeight(filtered, {
      stateKey: `droid:shared:${normalizedEndpoint}`
    })

    if (!selected) {
      throw new Error(`No schedulable account available after weighted scheduling (${normalizedEndpoint})`)
    }

    if (stickyKey && !isDedicatedBinding) {
      await redis.setSessionAccountMapping(stickyKey, selected.id)
    }

    await this._ensureLastUsedUpdated(selected.id)

    logger.info(
      `🤖 选择 Droid 账号 ${selected.name || selected.id}（endpoint: ${normalizedEndpoint}, weight: ${selected.priority || 50}）`
    )

    return selected
  }
}

module.exports = new DroidScheduler()
