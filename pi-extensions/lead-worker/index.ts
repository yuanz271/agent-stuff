/**
 * Lead–Worker extension
 *
 * Single extension providing both roles in a multi-session Pi setup:
 *
 *   Lead  — the session the user talks to. Activated via /lead <repo-path>.
 *            Delegates tasks to a per-repo worker and surfaces results.
 *
 *   Worker — one per repository. Spawned by the lead on first activation.
 *            Persists until explicitly killed. Does all hands-on work.
 *            Activated automatically when Pi is started with
 *            `pi --session <repo>/.pi/worker.jsonl`.
 *
 * See docs/lead-worker-spec.md for full design.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupLead } from "./lead.js";
import { setupWorker } from "./worker.js";

export default function (pi: ExtensionAPI) {
	setupLead(pi);
	setupWorker(pi);
}
