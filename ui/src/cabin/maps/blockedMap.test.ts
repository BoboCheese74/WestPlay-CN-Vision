import { describe, expect, it } from 'vitest'
import { HVT_MAP_MESSAGES, hvtMapMessage } from './blockedMap'

/** The languages this build has words for (owner 2026-11-18: English and Chinese only). */
const LANGUAGES = ['en_us', 'zh_cn', 'zh_tw']

describe('the HVT map message', () => {
  it('is in every language the game has, naming HVT and WestPlay', () => {
    expect(Object.keys(HVT_MAP_MESSAGES).sort()).toEqual(LANGUAGES)
    for (const message of Object.values(HVT_MAP_MESSAGES)) {
      expect(message).toContain('HVT')
      expect(message).toContain('WestPlay')
    }
  })

  it('says it in the game language, or English', () => {
    expect(hvtMapMessage('en_us')).toBe('Maps by HVT are not allowed in WestPlay. Contact WestPlay to learn more.')
    // A game in a language this build has no words for reads English (owner 2026-11-18).
    expect(hvtMapMessage('tr_tr')).toBe(HVT_MAP_MESSAGES.en_us)
    expect(hvtMapMessage('zh_cn')).toBe(HVT_MAP_MESSAGES.zh_cn)
    expect(hvtMapMessage('xx_mod')).toBe(HVT_MAP_MESSAGES.en_us)
    expect(hvtMapMessage(null)).toBe(HVT_MAP_MESSAGES.en_us)
  })
})
