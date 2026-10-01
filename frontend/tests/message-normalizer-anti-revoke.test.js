import { describe, expect, it } from 'vitest'
import { createMessageNormalizer } from '~/lib/chat/message-normalizer.js'

describe('message normalizer anti-revoke', () => {
  it('normalizes isRevoked and revokeTime attributes', () => {
    const normalize = createMessageNormalizer({
      apiBase: '/api',
      getSelectedAccount: () => 'wxid_my_account',
      getSelectedContact: () => ({ username: 'wxid_friend', name: 'Friend' }),
    })

    const rawNormal = {
      id: 'msg_1',
      localId: 101,
      serverId: 5001,
      type: 1,
      content: 'Hello',
      createTime: 1700000000,
    }
    const normalizedNormal = normalize(rawNormal)
    expect(normalizedNormal.isRevoked).toBe(false)
    expect(normalizedNormal.revokeTime).toBe(0)

    const rawRevoked = {
      id: 'msg_2',
      localId: 102,
      serverId: 5002,
      type: 1,
      content: 'This message was revoked',
      createTime: 1700000010,
      isRevoked: true,
      revokeTime: 1700000020,
      revokedServerId: '5002',
    }
    const normalizedRevoked = normalize(rawRevoked)
    expect(normalizedRevoked.isRevoked).toBe(true)
    expect(normalizedRevoked.revokeTime).toBe(1700000020)
    expect(normalizedRevoked.revokedServerId).toBe('5002')
  })
})
