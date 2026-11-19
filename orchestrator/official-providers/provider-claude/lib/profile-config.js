/**
 * The claude CLI keeps its sessions, debug logs and settings in its config folder: the one
 * `CLAUDE_CONFIG_DIR` names, else `~/.claude`, where the user's own Claude sign-in lives. The fence
 * opens `~/.claude` to the `claude` profile only, so every other profile on this dialect that runs
 * without an account (Kimi, an API-key profile, a user's file) is given a folder of its own,
 * kept across its missions so that a new mission still resumes another's session (TODO #1104).
 */
import { CLAUDE_PROFILE } from './profile.js';

/** Whether a launch of `profile` with no account gets a config folder of its own rather than `~/.claude`. */
export function needsOwnConfigDir(profile) {
  return profile.id !== CLAUDE_PROFILE.id;
}
