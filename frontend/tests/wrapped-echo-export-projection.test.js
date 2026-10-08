import { describe, expect, it } from 'vitest'
import { assertEchoCard, createEchoDocument } from '../lib/wrapped-echo-model.js'
import { createEchoArchiveHtml, createEchoExportDocument, renderEchoPosterSvg } from '../lib/wrapped-echo-export.js'
import { createEchoCardFixture, createEchoDetailFixture, FIXTURE_PRIVATE } from './fixtures/wrapped-echo-cards.js'

describe('production annual model to sharing outputs', () => {
  const document = () => {
    const cards = createEchoCardFixture()
    for (let id = 0; id < 7; id++) assertEchoCard(cards[id], { account: FIXTURE_PRIVATE.account, year: 2025, id })
    return createEchoDocument({ year: 2025, cards, loadedDetails: [createEchoDetailFixture()] })
  }
  it('removes every private source category from all ten poster SVGs and the offline archive', () => {
    const safe = createEchoExportDocument(document())
    expect(safe.scenes).toHaveLength(10)
    const outputs = [JSON.stringify(safe), createEchoArchiveHtml(safe), ...safe.scenes.map(scene => renderEchoPosterSvg(safe, { sceneId: scene.id }))]
    for (const output of outputs) for (const secret of [...FIXTURE_PRIVATE.names, ...FIXTURE_PRIVATE.phrases, FIXTURE_PRIVATE.message, FIXTURE_PRIVATE.account, FIXTURE_PRIVATE.username, FIXTURE_PRIVATE.anchor, FIXTURE_PRIVATE.path, '私密图片表情标记', '[微笑]', '🌙']) expect(output).not.toContain(secret)
    expect(safe.scenes[1].rows).toHaveLength(365)
    expect(safe.scenes[4].rows).toHaveLength(24)
    expect(createEchoArchiveHtml(safe)).toContain('2025-12-31')
  })

  it('keeps names separate from message text and never serializes source identities even with full opt-in', () => {
    const named = JSON.stringify(createEchoExportDocument(document(), { privacy: false }))
    expect(named).toContain(FIXTURE_PRIVATE.names[0])
    expect(named).not.toContain(FIXTURE_PRIVATE.phrases[0])
    expect(named).not.toContain(FIXTURE_PRIVATE.message)
    const optedIn = createEchoArchiveHtml(createEchoExportDocument(document(), { privacy: false, includeMessages: true, privateImages: true }))
    expect(optedIn).toContain(FIXTURE_PRIVATE.names[0])
    expect(optedIn).toContain(FIXTURE_PRIVATE.phrases[0])
    expect(optedIn).toContain(FIXTURE_PRIVATE.message)
    for (const source of [FIXTURE_PRIVATE.account, FIXTURE_PRIVATE.username, FIXTURE_PRIVATE.anchor, FIXTURE_PRIVATE.path, 'fixture-private-db']) expect(optedIn).not.toContain(source)
  })
})
