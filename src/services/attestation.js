/**
 * Optional native-app capture channel with device attestation.
 *
 * Browser capture cannot prove the camera feed is genuine. A native module can do better by
 * binding each capture to a hardware-backed attestation (Apple App Attest / Google Play Integrity)
 * over a server challenge. This module defines the server-side contract; a verifier must be
 * configured for the native endpoint to accept anything. With no verifier, the endpoint returns 501.
 *
 * A verifier is an object: { name, async verify({ attestation, challenge, imageSha256, sessionId, userId }) }
 * that resolves to { ok: true, deviceId, platform, details } or { ok: false, reason }.
 * It must check, at minimum:
 *   - the attestation signature chains to Apple / Google roots;
 *   - the app identity (bundle id / package name + signing cert) is ours;
 *   - the signed client data includes `challenge` (single-use, issued with the capture session) and
 *     `imageSha256`, so the attestation cannot be replayed onto another image.
 */
export function createAttestationVerifier(config) {
  if (typeof config.attestationVerifier === 'object' && config.attestationVerifier) return config.attestationVerifier;
  return null;
}
