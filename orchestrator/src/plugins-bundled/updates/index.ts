/**
 * Module `@timon/updates` — tells the user a newer Timon is published
 * (docs/AUTO-UPDATE.md, P1b). It reads the signed `releases.json`, offers a
 * version strictly above the installed one on the build's channel, publishes
 * `update_available` and leaves one notification per version. It downloads
 * and installs nothing: the banner links to the installer.
 *
 * It also reads the signed notice feed, `timon-notices.json` (§10), whose
 * announcements the app shows as notice cards.
 *
 * Tier `std`: on by default. `TIMON_UPDATES_CHECK` (env > config > settings >
 * default on) stops every request, the notice feed's included;
 * `TIMON_NOTICES_CHECK` stops the notice feed alone. A build run from the
 * sources (`dev`) and the test runner never check.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { liveMissionCount, workingMissionCount } from '../../agent.js';
import { buildInfo } from '../../build-info.js';
import { bus } from '../../bus.js';
import { timonVersion } from '../../data-version.js';
import { createNotification } from '../../notifications.js';
import { TIMON_HOME } from '../../paths.js';
import { settingBool } from '../../settings.js';
import { UpdateChecker, stateFileIn, type UpdateOffer } from './checker.js';
import { activeReleaseKeyring } from './keyring.js';
import { NoticesFeed, noticesStateFileIn } from './notices-checker.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@timon/updates',
  tier: 'std',
  inject: ['http', 'timer'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export const UPDATES_SETTING = 'TIMON_UPDATES_CHECK';
/**
 * A neighbour of the update check rather than the same switch: turning the
 * update check off keeps its promise of no request at all, while a person who
 * wants updates but no announcements turns this one off alone.
 */
export const NOTICES_SETTING = 'TIMON_NOTICES_CHECK';
/** First check once the daemon has settled, spread over a minute so a fleet started together does not hit the site together. */
const FIRST_CHECK_MIN_MS = 30_000;
const FIRST_CHECK_JITTER_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
/** A short tick that only looks at the clock: switching the setting back on applies without a restart. */
const TICK_MS = 10 * 60_000;

function checksAllowed(): boolean {
  return buildInfo().channel !== 'dev' && settingBool(UPDATES_SETTING);
}

const noticesEnabled = (): boolean => settingBool(UPDATES_SETTING) && settingBool(NOTICES_SETTING);

export function createNoticesFeed(): NoticesFeed {
  return new NoticesFeed({
    enabled: noticesEnabled,
    channel: () => buildInfo().channel,
    installed: timonVersion,
    keyring: activeReleaseKeyring,
    stateFile: noticesStateFileIn(TIMON_HOME),
  });
}

export function createChecker(): UpdateChecker {
  const created: UpdateChecker = new UpdateChecker({
    enabled: () => settingBool(UPDATES_SETTING),
    channel: () => buildInfo().channel,
    buildExpiresAt: () => buildInfo().expiresAt,
    installed: timonVersion,
    keyring: activeReleaseKeyring,
    stateFile: stateFileIn(TIMON_HOME),
    onOffer: (offer, channel) => announce(created, offer, channel),
  });
  return created;
}

/** `update_available` for every newly found version; one notification per version, ever. */
export function announce(target: UpdateChecker, offer: UpdateOffer, channel: 'beta' | 'stable'): void {
  bus.publish({ kind: 'update_available', version: offer.version, channel });
  if (!target.markNotified(offer.version)) return;
  createNotification({
    type: 'report',
    title: `Timon ${offer.version} is available`,
    body: `You run ${timonVersion()}. Open Timon to see what changed and download the installer.`,
    anchor: `timon-update:${offer.version}`,
  });
}

export function apply(ctx: Context): void {
  const checker = createChecker();
  const feed = createNoticesFeed();
  registerRoutes(ctx.http.router(), {
    status: () => checker.status(),
    check: () => checker.check(),
    missions: () => ({ live: liveMissionCount(), working: workingMissionCount() }),
    notices: () => feed.notices(),
  });

  // Not under the test runner: a suite that boots the kernel must not reach timon-ai.com.
  if (process.env.NODE_TEST_CONTEXT) return;
  let lastAttempt = 0;
  let lastNoticesAttempt = 0;
  const tick = (): void => {
    // Off or a source build: the clock is not even read, so switching it on checks at the next tick.
    if (!checksAllowed()) return;
    if (Date.now() - lastAttempt >= CHECK_INTERVAL_MS) {
      lastAttempt = Date.now();
      void checker.check();
    }
    if (noticesEnabled() && Date.now() - lastNoticesAttempt >= CHECK_INTERVAL_MS) {
      lastNoticesAttempt = Date.now();
      void feed.refresh();
    }
  };
  ctx.timeout(tick, FIRST_CHECK_MIN_MS + Math.floor(Math.random() * FIRST_CHECK_JITTER_MS));
  ctx.interval(tick, TICK_MS);
}
