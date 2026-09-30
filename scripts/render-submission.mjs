#!/usr/bin/env node
/** Refresh the seven-slide submission deck using the Codex bundled slide runtime.
 *
 * Outputs go to a new directory. Review all rendered pages before replacing the
 * published assets. The existing PPTX supplies the editable brand template.
 * RUNTIME_DEPS and PRESENTATIONS_SKILL_DIR can override the bundled locations.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'output-dir': { type: 'string' },
  'source-deck': { type: 'string' },
  'screenshots-dir': { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/render-submission.mjs --output-dir <new-directory> [--source-deck <pptx>] [--screenshots-dir <directory>]');
  process.exit(0);
}
const deps = process.env.RUNTIME_DEPS ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
process.env.RUNTIME_NODE_MODULES ??= path.join(deps, 'node/node_modules');
const skill = process.env.PRESENTATIONS_SKILL_DIR ?? path.join(os.homedir(), '.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations');
const output = path.resolve(values['output-dir'] ?? path.join(root, 'output', `submission-${Date.now()}`));
const source = path.resolve(values['source-deck'] ?? path.join(root, 'artifacts/submission/nursebridge-pitch.pptx'));
const screenshots = path.resolve(values['screenshots-dir'] ?? path.join(root, 'artifacts/demo/source'));
const { FileBlob, PresentationFile } = await import(pathToFileURL(path.join(deps, 'node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs')).href);
const { finalizePresentation } = await import(pathToFileURL(path.join(skill, 'container_tools/artifact_tool_utils.mjs')).href);
const deck = await PresentationFile.importPptx(await FileBlob.load(source));
if (deck.slides.items.length !== 7) throw new Error('Expected the seven-slide NurseBridge template.');
const inspected = (await deck.inspect({ kind: 'textbox,image', maxChars: 100000 })).ndjson.trim().split('\n').map(line => JSON.parse(line));
function textAt(slide, left, top, copy) {
  const item = inspected.find(item => item.kind === 'textbox' && item.slide === slide && item.bbox[0] === left && item.bbox[1] === top);
  if (!item) throw new Error(`Template text anchor is missing at slide ${slide}, ${left}, ${top}`);
  const shape = deck.resolve(item.id);
  shape.text.replace(item.text, copy);
  return shape;
}

// Recorded results from the 29 Sep 2026 polish pass. Update only after a new
// full verification run, and keep docs/test-results.md consistent with the deck.
textAt(6, 72, 158, '168');
textAt(6, 450, 158, '177');
textAt(6, 828, 158, '29');
textAt(6, 72, 359, '29 Sep 2026 local regression run. 19 tooling tests also passed.\nThe regression run skipped one separate live-provider test.');
textAt(6, 72, 489, 'Local real-provider proof');
textAt(6, 72, 547, '29 Sep 2026: finalized transcript, evidence-linked fact and two-way browser audio using recorded microphones.');
textAt(6, 716, 489, 'Remaining release gates');
textAt(6, 716, 574, 'Hosted operation, physical-device audio, provider recording controls and real telephone calls.');
textAt(7, 72, 225, 'Nurses who need caller context before joining a conversation.');
textAt(7, 728, 231, 'Nurse interviews and fictional case reviews');
textAt(7, 728, 335, 'Two physical devices and audible handoff');
textAt(7, 728, 439, 'Provider recording controls and hosted acceptance');
textAt(7, 728, 543, 'Live telephone call for the optional phone path');

const sources = [
  { slide: 2, file: 'caller-intake.png', alt: 'Fictional caller intake in local mock replay mode', crop: { left: 0.21736, top: 0.18687, right: 0.36528, bottom: 0.32179 } },
  { slide: 3, file: 'human-handoff.png', alt: 'Nurse takeover during a local mock replay with fixture browser audio', crop: { left: 374 / 1440, top: 465 / 2041, right: 364 / 1440, bottom: 1142 / 2041 } },
  { slide: 4, file: 'nurse-evidence.png', alt: 'Fictional intake correction with supporting words and revision history', crop: { left: 0.26111, top: 0.17209, right: 0.02083, bottom: 0.508 } },
];
for (const entry of sources) {
  const record = inspected.find(item => item.kind === 'image' && item.slide === entry.slide);
  if (!record) throw new Error(`Screenshot anchor missing from slide ${entry.slide}`);
  const image = deck.resolve(record.id);
  const frame = image.frame;
  const fit = image.fit;
  image.replace({ blob: await fs.readFile(path.join(screenshots, entry.file)), contentType: 'image/png', alt: entry.alt });
  image.frame = frame;
  image.fit = fit;
  image.crop = entry.crop;
}
const sharedNotes = 'NurseBridge is a fictional simulation, not for medical care. Product sources: docs/architecture.md, docs/voice-agent.md and docs/demo-script.md. Actual app captures under artifacts/demo/source show labeled local mock replay. No production, clinical, physical-device or real telephone-network acceptance is claimed.';
const notes = [
  'AssemblyAI Voice Agent Hackathon submission deck. All caller information is fictional.',
  'The problem and proposed benefit are hypotheses for nurse workflow research. Screenshot: artifacts/demo/source/caller-intake.png.',
  'Screenshot: artifacts/demo/source/human-handoff.png. Mock intake fixtures and actual browser audio transport are separate layers. The capture uses synthetic microphone inputs.',
  'Screenshot: artifacts/demo/source/nurse-evidence.png. Original fictional correction: I need to correct that: the headache started this morning, not yesterday. Supporting words establish provenance rather than medical accuracy.',
  'The AssemblyAI conversation uses configured Nebius Nemotron-3.5-Lightning. Independent extraction validates finalized caller evidence. The CallSession Durable Object controls consent and human takeover. D1 stores projections and R2 private exports.',
  'Sources: docs/test-results.md and docs/evidence/polished-live-voice-2026-09-29.json. Regression results: 168 unit, 177 Workers, 19 tooling, 29 browser, with one live-provider test skipped in that regression run. Separate opted-in local AssemblyAI/Nebius acceptance passed on the polished source revision 743cce2 on 29 Sep 2026 in 30.8 seconds, using recorded microphones. It produced one finalized caller turn, one evidence-linked fact, three assistant turns, non-silent human playback in both receiving worklets, zero stale agent samples, and zero dropped frames. The case finished CLOSED and deleted, with no pending provider deletions or unresolved provider connections. These are individual local observations, not reliability or latency guarantees. Provider API logical deletion is not proof of physical erasure or backup expiry. Public live activation still requires recording-control and physical-device acceptance. No hosted deployment or real telephone-network acceptance is claimed.',
  'Proposed users and business model remain hypotheses. No customers, clinical partners, user interviews, measured time savings or clinical outcomes are claimed. Pending verification sources: docs/production-readiness.md, docs/phone-inbound.md and docs/safety-and-privacy.md.',
];
for (let index = 0; index < notes.length; index++) deck.slides.items[index].speakerNotes.textFrame.setText(`${sharedNotes}\n${notes[index]}`);

await fs.mkdir(output, { recursive: true });
const build = path.join(output, '.build');
const finalDir = path.join(output, 'files');
await fs.mkdir(build, { recursive: true });
await fs.mkdir(finalDir, { recursive: true });
const candidate = path.join(build, 'candidate.pptx');
const finalPptx = path.join(finalDir, 'nursebridge-pitch.pptx');
await (await PresentationFile.exportPptx(deck)).save(candidate);
await finalizePresentation({
  workspaceDir: output,
  candidatePath: candidate,
  finalPath: finalPptx,
  explicitTotalSlideCount: 7,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [],
  pythonExecutable: path.join(deps, 'python/bin/python3'),
  integrityValidatorPath: path.join(skill, 'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(skill, 'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-bullet-geometry', '--validate-heading-fit'],
  fontPolicy: { basis: 'design', families: ['Helvetica Neue'] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(build, 'validation.json'),
});
// Only the Codex bundled headless LibreOffice is used for PDF conversion.
// The headless bundle needs an explicit system-font search path on macOS.
const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const fontConfig = path.join(build, 'fontconfig.xml');
await fs.writeFile(fontConfig, `<?xml version="1.0"?><fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><cachedir>${xmlText(path.join(build, 'font-cache'))}</cachedir></fontconfig>`);
execFileSync(path.join(deps, 'bin/override/soffice'), [
  `-env:UserInstallation=${pathToFileURL(path.join(build, 'libreoffice-profile')).href}`,
  '--headless', '--convert-to', 'pdf', '--outdir', finalDir, finalPptx,
], { stdio: 'inherit', timeout: 60000, env: { ...process.env, FONTCONFIG_FILE: fontConfig } });
execFileSync(path.join(deps, 'bin/override/pdftoppm'), [
  '-png', '-scale-to', '1440', path.join(finalDir, 'nursebridge-pitch.pdf'), path.join(build, 'slide'),
], { stdio: 'inherit', timeout: 60000 });
const cover = await deck.export({ slide: deck.slides.items[0], format: 'png', scale: 1.5 });
await fs.writeFile(path.join(finalDir, 'nursebridge-cover.png'), new Uint8Array(await cover.arrayBuffer()));
console.log(`Review seven PNGs and validation.json in ${build} before promoting the three outputs in ${finalDir}.`);
