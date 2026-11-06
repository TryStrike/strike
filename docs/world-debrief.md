# World integration debrief

Team Strike, ETHGlobal Mumbai. Products used: IDKit 4 (`@worldcoin/idkit` 4.6.0, World ID 4.0) and World ID Agent Pass (OIDC device flow). Backend in Rust (axum), frontend in Next.js.

What we built is in `docs/world.md`: IDKit makes one human key per person, limits are counted per human across wallets, and Agent Pass asks that human for a fresh approval before risky agent actions, big proposals and big withdrawals.

## Time to first success

| Milestone | When | Effort |
|---|---|---|
| IDKit: first proof verified on our backend (staging, simulator.worldcoin.org) | 2026-11-06, evening | first try |
| Agent Pass: first device-flow approval verified on our backend (sandbox issuer) | 2026-11-06, 19:17 UTC | about 2 hours of environment and credential friction |
| Agent Pass: first protected action run from an approval (YOLO agent start, approval spent once) | 2026-11-06, same session | right after the first approval |

The code itself was ready before the first live call. It had been built against a fake World server we wrote (device, token and JWKS endpoints signed with a test RSA key), and the only check the real token forced us to change was the passkey rule. While debugging we also added the `WORLD_AP_ACR` setting and logging of World's `error_description`. Almost all of the two hours went into finding an environment and an account that World would approve.

IDKit was smooth: unverified bet refused, cancel recorded, simulator proof verified through the v4 verify API, wallet linked to an Orb-tier human, bet retried and placed, and a bet over the Orb exposure cap refused with no money moved.

## Friction

In the order it cost us time.

1. **Production Agent Pass needs an Orb, and Selfie Check is off everywhere.** `GET /api/v1/features` returns `selfieCheck: false` on production and sandbox, and discovery lists only `orb` and `orb-face` in `acr_values_supported`. Asking for orb or selfie silently becomes orb, and listing selfie first changes nothing. There are no Orbs in India, so at a Mumbai event a team cannot get a single production approval. We moved to `https://sandbox.auth.world.org` with a sandbox client.
2. **The sandbox "simulated human" is refused, and the error does not say why.** With the sandbox World App's "simulated human" in Developer Settings, every approval ended `access_denied` ("Authorization was denied."). World's page showed only "Something went wrong" and a reference. The token endpoint error gave nothing more useful, and the detail was only visible in the browser page. What finally worked: run the Orb communication test with our ID in the sandbox app, reset the app settings to default, create the account linked with a passkey, and approve with the passkey. That token came back with `acr = orb`, `amr = pop user mfa`. None of these steps are documented.
3. **Passkey approvals carry `mfa`, which our first policy refused.** We had read `pop` without `mfa` as "fresh World ID proof" and treated `mfa` as "only a passkey". World's docs say a passkey on an Orb-level account is valid, and that is what the sandbox returned. We changed the check to require `pop` and accept `mfa`.
4. **The Agent Pass portal needs an enterprise Google account.** Signing in needs a Workspace Google account. Hackathon teams often don't have one, so this blocks a team before it writes any code.
5. **HTTPS-only redirect URI, even for a device-only client.** We never redirect anywhere, but registration still required an HTTPS redirect URI. On localhost that means making up a URL you don't use.
6. **How proofs are mocked at the event is not written down.** We were told Agent Pass proofs are mocked for this hackathon, but found nothing on how. A "Test Environment, mock proofs" host appears in the IdP's frontend bundle but is not public.
7. **No `binding_message`, so the approval screen can't say what is being approved.** The device flow shows only a user code. Our UI shows "Withdraw 30 USDC" next to the code, but the screen where the human actually decides doesn't.
8. **The IDKit nullifier and the Agent Pass `sub` are unrelated, with no documented link.** We link them on first approval (trust on first use) and require the same `sub` after that. A first approval from someone else's World App would bind the wrong identity, and we cannot check it against the nullifier.
9. **No official server SDK for Agent Pass.** We wrote the device grant, `slow_down` handling, JWKS caching and RS256 checks ourselves (`core/src/agentpass/`). Each of those is a place a team can get security wrong.

One bug on our side worth noting: a single click on "Sign and approve in World App" opened two or three `auth.world.org` tabs. Fixed in this branch.

## What we confirmed live

- Discovery exposes `device_authorization_endpoint`, `token_endpoint` and `jwks_uri` under those names.
- The device-flow `id_token` carries `auth_time`, `acr` and `amr`.
- A passkey approval on an Orb-level account gives `acr = https://world.org/oidc/acr/orb` and `amr = ["pop", "user", "mfa"]`.
- `access_denied` and `expired_token` arrive as RFC 8628 errors and end the step-up unapproved.

Not seen yet: `slow_down`. We assume it comes as HTTP 400 like the other errors.

## Missing capability and missing docs

- A working selfie-level Agent Pass, or a clear statement that it is off and when it returns.
- A sandbox account path that works out of the box, written down step by step, and a public mock-proof environment for hackathons.
- Device-flow errors that carry the real reason in `error_description`, not only on World's own web page.
- The exact claims in a device-flow `id_token`, what each `amr` value means, and which `acr` values a client can ask for, kept in sync with discovery and the features endpoint.
- Error codes from the device and token endpoints, with HTTP statuses and rate limits.
- How (or whether) an Agent Pass `sub` relates to an IDKit nullifier for the same person.
- Device-only clients without a redirect URI, and portal sign-in without a Workspace account.

## The one improvement with the greatest impact

**Let the relying party show the action on the approval screen** (a `binding_message` or equivalent on the device and step-up flows). Agent Pass is about a human approving what their agent is about to do. Today the human approves a code, not an action. With the action shown in World App ("Strike: withdraw 30 USDC"), the approval means something, phishing a code for a different action gets much harder, and apps no longer need to rely on their own UI being honest.

A close second, from our own time sheet: a sandbox that accepts a test human on the first try, with errors that say what went wrong. That was two hours of our hackathon; IDKit took minutes.
