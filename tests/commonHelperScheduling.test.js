jest.mock(
  '../config/config',
  () => ({
    security: {
      encryptionKey: 'test-encryption-key'
    },
    system: {
      timezoneOffset: 8
    }
  }),
  { virtual: true }
)

const {
  selectAccountBySchedulingWeight,
  normalizeSchedulingWeight
} = require('../src/utils/commonHelper')

describe('account scheduling helpers', () => {
  describe('normalizeSchedulingWeight', () => {
    it('keeps account weights within the supported 1-100 range', () => {
      expect(normalizeSchedulingWeight(1)).toBe(1)
      expect(normalizeSchedulingWeight('75')).toBe(75)
      expect(normalizeSchedulingWeight(100)).toBe(100)
      expect(normalizeSchedulingWeight(undefined)).toBe(50)
      expect(normalizeSchedulingWeight(0)).toBe(50)
      expect(normalizeSchedulingWeight(101)).toBe(100)
    })
  })

  describe('selectAccountBySchedulingWeight', () => {
    it('uses larger priority values as larger scheduling weights', () => {
      const accounts = [
        { accountId: 'low', accountType: 'openai', priority: 1 },
        { accountId: 'high', accountType: 'openai', priority: 3 }
      ]
      const stateStore = new Map()

      const selections = Array.from({ length: 4 }, () =>
        selectAccountBySchedulingWeight(accounts, {
          stateKey: 'test:openai',
          stateStore
        }).accountId
      )

      expect(selections).toEqual(['high', 'low', 'high', 'high'])
      expect(selections.filter((id) => id === 'low')).toHaveLength(1)
      expect(selections.filter((id) => id === 'high')).toHaveLength(3)
    })

    it('removes unavailable accounts from the scheduling state', () => {
      const stateStore = new Map()
      const pool = [
        { accountId: 'a', accountType: 'openai', priority: 1 },
        { accountId: 'b', accountType: 'openai', priority: 1 }
      ]

      selectAccountBySchedulingWeight(pool, {
        stateKey: 'test:cleanup',
        stateStore
      })
      selectAccountBySchedulingWeight([pool[0]], {
        stateKey: 'test:cleanup',
        stateStore
      })

      const state = stateStore.get('test:cleanup')
      expect([...state.keys()]).toEqual(['openai:a'])
    })

    it('caps scheduling state keys with least recently used eviction', () => {
      const stateStore = new Map()
      const accounts = [{ accountId: 'a', accountType: 'openai', priority: 1 }]

      selectAccountBySchedulingWeight(accounts, {
        stateKey: 'model:a',
        stateStore,
        maxStateKeys: 2
      })
      selectAccountBySchedulingWeight(accounts, {
        stateKey: 'model:b',
        stateStore,
        maxStateKeys: 2
      })
      selectAccountBySchedulingWeight(accounts, {
        stateKey: 'model:a',
        stateStore,
        maxStateKeys: 2
      })
      selectAccountBySchedulingWeight(accounts, {
        stateKey: 'model:c',
        stateStore,
        maxStateKeys: 2
      })

      expect([...stateStore.keys()]).toEqual(['model:a', 'model:c'])
    })

    it('keeps at least one scheduling state when given an invalid state cap', () => {
      const stateStore = new Map()
      const accounts = [{ accountId: 'a', accountType: 'openai', priority: 1 }]

      selectAccountBySchedulingWeight(accounts, {
        stateKey: 'model:a',
        stateStore,
        maxStateKeys: 0
      })

      expect([...stateStore.keys()]).toEqual(['model:a'])
    })
  })
})
