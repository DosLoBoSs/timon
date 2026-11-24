// @ts-check
/**
 * opencode, Hermes and Antigravity as one official provider plugin, written against `ctx.provider` and
 * nothing else (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). It ships in the release, is loaded the
 * way a third party's plugin is, and its files are vouched for by the signed inventory.
 *
 * Each agent is a row of data (`agents.js`) handed to the daemon's own ACP runtime, so what the
 * plugin brings is the declaration, not a copy of the protocol: a fix to the session driver or to
 * the model probe reaches every agent with the daemon. The profile ids and the id of each
 * provider are the product's own (`opencode`, `hermes`, `antigravity`); the
 * profiles themselves are in `profiles.js`. Pi has a plugin of its own (`provider-pi`).
 */
import { join } from 'node:path'
import { ACP_AGENTS, antigravityUsage } from './agents.js'
import { ANTIGRAVITY_PROFILE, HERMES_PROFILE, OPENCODE_PROFILE } from './profiles.js'

export const name = 'provider-acp'

/** The XDG folders opencode keeps its cache and its state in, moved into the profile's own folder. */
const OPENCODE_STATE_VARS = Object.freeze({ XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })

/**
 * opencode keeps its cache (the models list, the npm packages of its providers, the tools it
 * downloads) under XDG_CACHE_HOME, and its state (the locks around its sign-in file and around the
 * models refresh, recent models, prompt history) under XDG_STATE_HOME: both in the user's home,
 * which the mission fence keeps read-only. Traced under the fence (opencode 1.19.5): every lock
 * fails, so the CLI reads its sign-in without one and skips the models refresh, and a provider
 * whose package it has not cached yet cannot be installed. Both move to the profile's own folder,
 * which the fence grants to that profile's missions. Its configuration and its sign-in
 * (XDG_CONFIG_HOME, XDG_DATA_HOME) stay where the user's own opencode reads them, and so do its
 * sessions, which a later mission resumes. Declaring the two folders instead is not possible: the
 * manifest already lists the four credential folders a provider plugin may declare.
 *
 * A variable the profile sets itself is kept. A launch on an account gets no profile folder
 * (`scratch.profile` refuses it): it keeps the CLI's defaults.
 *
 * @param {import('@timon-ai/sdk/provider').NativeProviderDefinition} definition
 * @param {import('@timon-ai/sdk/provider').ProviderServices['scratch']} scratch
 * @returns {import('@timon-ai/sdk/provider').NativeProviderDefinition}
 */
export function withOpencodeStateFolders(definition, scratch) {
  return {
    ...definition,
    async launch(spawn, profile) {
      const launch = await definition.launch(spawn, profile)
      let folder
      try {
        folder = scratch.profile(profile).path
      } catch {
        return launch
      }
      const own = profile.env ?? {}
      const moved = Object.fromEntries(Object.entries(OPENCODE_STATE_VARS)
        .filter(([variable]) => !Object.hasOwn(own, variable))
        .map(([variable, sub]) => [variable, join(folder, sub)]))
      return { ...launch, env: { ...launch.env, ...moved } }
    },
  }
}

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  const { acp } = ctx.provider.runtime
  for (const agent of ACP_AGENTS) {
    const definition = acp.defineProvider(ctx.provider, agent)
    // Only Antigravity reports a quota; the row has no field for it (`agents.js`).
    if (agent.id === 'antigravity') ctx.provider.registerProvider({ ...definition, usage: antigravityUsage(ctx.provider) })
    else if (agent.id === 'opencode') ctx.provider.registerProvider(withOpencodeStateFolders(definition, ctx.provider.scratch))
    else ctx.provider.registerProvider(definition)
  }
  for (const profile of [OPENCODE_PROFILE, HERMES_PROFILE, ANTIGRAVITY_PROFILE]) ctx.provider.registerProductProfile(profile)
}
