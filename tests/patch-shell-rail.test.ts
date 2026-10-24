// CLI contract for scripts/patch-shell-rail.mjs (S12, L50).
//
// gentle-shell paints a hardcoded allowlist of rail sections, and the `notes`
// entry that makes this extension's rail card visible is a local patch to
// gentle-shell, not upstream code. `gentle-pi` auto-updates at startup, so a
// shell update silently drops that patch and the notes stop rendering in the
// sidebar (see src/sidebar-interop.ts). The repository ships the
// re-application as a command; these tests drive the real CLI: exit codes,
// exact stdout and stderr, and that a refusal leaves every file untouched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "patch-shell-rail.mjs");
const LAYOUT = "lib/shell-sidebar-layout.ts";
const SIDEBAR = "lib/shell-sidebar.ts";

const TABS = "\t\t\t";
const LAYOUT_UNPATCHED = `${TABS}const sections = ["footer", "agents", "todo"].filter((key) => key !== "todo" || state.visibility?.todo !== false).map((key) => {`;
const LAYOUT_PATCHED = `${TABS}const sections = ["footer", "agents", "todo", "notes"].filter((key) => (key !== "todo" || state.visibility?.todo !== false) && (key !== "notes" || state.visibility?.notes !== false)).map((key) => {`;
const SIDEBAR_UNPATCHED = "\tvisibility?: { todo?: boolean };";
const SIDEBAR_PATCHED = "\tvisibility?: { todo?: boolean; notes?: boolean };";

function layoutSource(sections: string): string {
	return [
		"// gentle-pi lib/shell-sidebar-layout.ts (fixture)",
		"export function installSidebar(): void {",
		`${TABS}const headerPart = state.parts.get("header");`,
		`${TABS}const contentWidth = scroll.getContentWidth(RAIL_WIDTH);`,
		sections,
		`${TABS}\treturn;`,
		`${TABS}});`,
		"}",
		"",
	].join("\n");
}

function sidebarSource(visibility: string): string {
	return ["// gentle-pi lib/shell-sidebar.ts (fixture)", "export interface SidebarState {", "\tactive: boolean;", visibility, "}", ""].join("\n");
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "patch-shell-rail-"));
	roots.push(root);
	return root;
}

/** A fake installed package with the shell files, shaped like the real ones. */
function fakePackage(files: { layout?: string | undefined; sidebar?: string | undefined; mode?: number } = {}): string {
	const root = scratch();
	mkdirSync(join(root, "lib"), { recursive: true });
	const mode = files.mode ?? 0o664;
	if (files.layout !== undefined) writeFileSync(join(root, LAYOUT), files.layout, { mode });
	if (files.sidebar !== undefined) writeFileSync(join(root, SIDEBAR), files.sidebar, { mode });
	return root;
}

const unpatched = (): string => fakePackage({ layout: layoutSource(LAYOUT_UNPATCHED), sidebar: sidebarSource(SIDEBAR_UNPATCHED) });
const patched = (): string => fakePackage({ layout: layoutSource(LAYOUT_PATCHED), sidebar: sidebarSource(SIDEBAR_PATCHED) });

function run(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function read(root: string, file: string): string {
	return readFileSync(join(root, file), "utf8");
}

describe("patch-shell-rail", () => {
	it("patches both shell files and names each one", () => {
		const root = unpatched();

		const result = run(["--root", root]);

		assert.equal(result.code, 0);
		assert.equal(
			result.stdout,
			[
				`patch-shell-rail: ${LAYOUT} patched`,
				`patch-shell-rail: ${SIDEBAR} patched`,
				"patch-shell-rail: 2 changes applied — restart Pi to load the notes rail section",
				"",
			].join("\n"),
		);
		assert.equal(result.stderr, "");
		assert.equal(read(root, LAYOUT), layoutSource(LAYOUT_PATCHED));
		assert.equal(read(root, SIDEBAR), sidebarSource(SIDEBAR_PATCHED));
		// Atomicity is observable: no temporary file survives the write.
		assert.deepEqual(readdirSync(join(root, "lib")).sort(), [LAYOUT.slice(4), SIDEBAR.slice(4)].sort());
	});

	it("is idempotent: a second run changes nothing", () => {
		const root = unpatched();
		run(["--root", root]);
		const layout = read(root, LAYOUT);
		const sidebar = read(root, SIDEBAR);

		const result = run(["--root", root]);

		assert.equal(result.code, 0);
		assert.equal(
			result.stdout,
			[
				`patch-shell-rail: ${LAYOUT} already patched`,
				`patch-shell-rail: ${SIDEBAR} already patched`,
				"patch-shell-rail: nothing to do — the notes rail section is already patched",
				"",
			].join("\n"),
		);
		assert.equal(result.stderr, "");
		assert.equal(read(root, LAYOUT), layout);
		assert.equal(read(root, SIDEBAR), sidebar);
	});

	it("patches only the file an update dropped", () => {
		const root = fakePackage({ layout: layoutSource(LAYOUT_PATCHED), sidebar: sidebarSource(SIDEBAR_UNPATCHED) });

		const result = run(["--root", root]);

		assert.equal(result.code, 0);
		assert.equal(
			result.stdout,
			[
				`patch-shell-rail: ${LAYOUT} already patched`,
				`patch-shell-rail: ${SIDEBAR} patched`,
				"patch-shell-rail: 1 change applied — restart Pi to load the notes rail section",
				"",
			].join("\n"),
		);
		assert.equal(read(root, LAYOUT), layoutSource(LAYOUT_PATCHED));
		assert.equal(read(root, SIDEBAR), sidebarSource(SIDEBAR_PATCHED));
	});

	it("--check reports a missing patch with exit 1 and writes nothing", () => {
		const root = unpatched();
		const layout = read(root, LAYOUT);
		const sidebar = read(root, SIDEBAR);

		const result = run(["--check", "--root", root]);

		assert.equal(result.code, 1);
		assert.equal(
			result.stdout,
			[
				`patch-shell-rail: ${LAYOUT} needs patching`,
				`patch-shell-rail: ${SIDEBAR} needs patching`,
				"patch-shell-rail: run npm run patch:shell-rail",
				"",
			].join("\n"),
		);
		assert.equal(result.stderr, "");
		assert.equal(read(root, LAYOUT), layout);
		assert.equal(read(root, SIDEBAR), sidebar);
	});

	it("--check passes on a patched package with exit 0", () => {
		const root = patched();

		const result = run(["--check", "--root", root]);

		assert.equal(result.code, 0);
		assert.equal(
			result.stdout,
			[
				`patch-shell-rail: ${LAYOUT} already patched`,
				`patch-shell-rail: ${SIDEBAR} already patched`,
				"patch-shell-rail: notes rail section present",
				"",
			].join("\n"),
		);
		assert.equal(result.stderr, "");
	});

	it("refuses an unknown layout shape without writing anything", () => {
		const root = fakePackage({ layout: layoutSource(`${TABS}const sections = ["footer"].filter(Boolean).map((key) => {`), sidebar: sidebarSource(SIDEBAR_UNPATCHED) });
		const layout = read(root, LAYOUT);
		const sidebar = read(root, SIDEBAR);

		const result = run(["--root", root]);

		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(
			result.stderr,
			[`patch-shell-rail: ${LAYOUT} has no recognisable rail section list`, "patch-shell-rail: nothing written", ""].join("\n"),
		);
		assert.equal(read(root, LAYOUT), layout);
		assert.equal(read(root, SIDEBAR), sidebar);
	});

	it("refuses a package where a shell file is missing", () => {
		const root = fakePackage({ layout: layoutSource(LAYOUT_UNPATCHED) });
		const layout = read(root, LAYOUT);

		const result = run(["--root", root]);

		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, [`patch-shell-rail: ${SIDEBAR} is missing`, "patch-shell-rail: nothing written", ""].join("\n"));
		assert.equal(read(root, LAYOUT), layout);
	});

	it("reports a missing package instead of touching the filesystem", () => {
		const root = scratch();

		const result = run(["--root", join(root, "absent")]);

		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(
			result.stderr,
			[`patch-shell-rail: no gentle-pi package at ${join(root, "absent")}`, "patch-shell-rail: pass --root <path> or set GENTLE_SHELL_ROOT", ""].join("\n"),
		);
		assert.deepEqual(readdirSync(root), []);
	});

	it("resolves the default package from the config home", () => {
		const home = scratch();

		const result = run([], { HOME: home });

		assert.equal(result.code, 1);
		assert.equal(
			result.stderr,
			[`patch-shell-rail: no gentle-pi package at ${join(home, ".pi", "agent", "npm", "node_modules", "gentle-pi")}`, "patch-shell-rail: pass --root <path> or set GENTLE_SHELL_ROOT", ""].join("\n"),
		);
	});

	it("honours GENTLE_SHELL_ROOT and lets --root win over it", () => {
		const envRoot = unpatched();
		const flagRoot = unpatched();

		const viaEnv = run([], { GENTLE_SHELL_ROOT: envRoot });
		const viaFlag = run(["--root", flagRoot], { GENTLE_SHELL_ROOT: envRoot });

		assert.equal(viaEnv.code, 0);
		assert.equal(read(envRoot, LAYOUT), layoutSource(LAYOUT_PATCHED));
		assert.equal(viaFlag.code, 0);
		assert.equal(read(flagRoot, LAYOUT), layoutSource(LAYOUT_PATCHED));
	});

	it("keeps the mode of the file it replaces", () => {
		const root = fakePackage({ layout: layoutSource(LAYOUT_UNPATCHED), sidebar: sidebarSource(SIDEBAR_UNPATCHED), mode: 0o600 });

		const result = run(["--root", root]);

		assert.equal(result.code, 0);
		assert.equal(statSync(join(root, LAYOUT)).mode & 0o7777, 0o600);
		assert.equal(statSync(join(root, SIDEBAR)).mode & 0o7777, 0o600);
	});

	it("rejects --root without a path", () => {
		const result = run(["--root"]);

		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, ["patch-shell-rail: --root needs a path", "patch-shell-rail: usage: patch-shell-rail [--check] [--root <path>]", ""].join("\n"));
	});

	it("rejects an unknown option with the usage line", () => {
		const result = run(["--force"]);

		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(
			result.stderr,
			["patch-shell-rail: unknown option --force", "patch-shell-rail: usage: patch-shell-rail [--check] [--root <path>]", ""].join("\n"),
		);
	});
});