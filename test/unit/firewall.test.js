import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseFirewall, parsePublicKeys } from '../../src/p2p/firewall.js'

describe('parsePublicKeys', () => {
  it('splits commas, spaces and newlines', () => {
    assert.deepEqual(parsePublicKeys('aa, bb\ncc'), ['aa', 'bb', 'cc'])
  })

  it('drops empty pieces', () => {
    assert.deepEqual(parsePublicKeys('  , ,aa,  '), ['aa'])
  })
})

describe('parseFirewall', () => {
  it('is off when no keys and no mode are set', () => {
    assert.equal(parseFirewall(), null)
    assert.equal(parseFirewall({ mode: '', publicKeys: [] }), null)
  })

  it('defaults to an allow-list when keys are present', () => {
    assert.deepEqual(parseFirewall({ publicKeys: 'aaa,bbb,aaa' }), {
      mode: 'allow',
      publicKeys: ['aaa', 'bbb'],
    })
  })

  it('accepts deny mode', () => {
    assert.deepEqual(parseFirewall({ mode: 'DENY', publicKeys: ['evil'] }), {
      mode: 'deny',
      publicKeys: ['evil'],
    })
  })

  it('rejects an unknown mode', () => {
    assert.throws(() => parseFirewall({ mode: 'maybe', publicKeys: ['aaa'] }), /allow or deny/)
  })

  it('rejects a mode with no keys', () => {
    assert.throws(() => parseFirewall({ mode: 'allow' }), /at least one consumer public key/)
  })
})
