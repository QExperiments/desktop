// I.1.1 allow/deny list of consumer public keys. Live checklist: docs/p2p-test.md
export const parsePublicKeys = (value) =>
  String(value ?? '')
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean)

export const parseFirewall = ({ mode = '', publicKeys = [] } = {}) => {
  const keys = [...new Set((Array.isArray(publicKeys) ? publicKeys : parsePublicKeys(publicKeys)).filter(Boolean))]
  const resolved = String(mode ?? '').trim().toLowerCase() || (keys.length ? 'allow' : '')

  if (!resolved) return null
  if (resolved !== 'allow' && resolved !== 'deny') {
    throw new Error(`QVAC_FIREWALL_MODE must be allow or deny, not ${mode}`)
  }

  if (!keys.length) {
    throw new Error(`QVAC_FIREWALL_MODE=${resolved} needs at least one consumer public key`)
  }

  return { mode: resolved, publicKeys: keys }
}
