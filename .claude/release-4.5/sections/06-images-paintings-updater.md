# 06 - Images, paintings, file/asset controllers, mod updater, app self-updater

App repo `jasmine-phase-3` @ 62b9bad (release/app version **4.0.8**). Read-only survey, 2026-09-23.
Upstream reference: `upstream/main` = cf65dab **4.1.0** (there is no `upstream/develop` ref locally; the fork is 9 commits behind upstream/main).
Tiers: CORE (upstream feature, ships everywhere) / AUTONOMY / STREAM / DEV. "KILL" = CORE code that must be disabled in any build Gus does not publish himself.

## 1. File inventory

| File (src/main/sentient-sims/ unless noted) | What it is | Tier | vs upstream/main | Tests |
|---|---|---|---|---|
| services/ImageGenerationService.ts (7) | Interface `generateImage(req)`, always returns base64 | CORE | identical | via providers |
| services/ImageProviderConfigService.ts (45) | Resolves image provider config: explicit `configId`, else `defaultImageProviderConfigId`, else **Auto** = `aiApiType` if image-capable, else first type with credentials, else OpenAI | CORE | identical | ImageProviderConfig.test.ts (290) |
| services/OpenAIImageGenerationService.ts (46) | OpenAI `images.generate` (default `gpt-image-1`; dall-e forced to `b64_json`); passes `size` | CORE | identical | **none** |
| services/GeminiService.ts:223-253 | `generateImage` via `generateContent` with IMAGE modality; ignores `size` | CORE | (mixed file) | GeminiImage.test.ts (91) |
| services/SentientSimsAIService.ts:128-172 | POST `{sentientSimsAIEndpoint}/v1/images/generations` `{model,prompt}` (130 s timeout, Cognito `accessToken`), downloads URL results; ignores `size` | CORE | (mixed file) | **none** |
| services/PaintingMountService.ts (54) | Creates `Mods/sentient-sims/paintings/` and appends the `DirectoryFiles` block to `Mods/Resource.cfg` | CORE | **behind**: upstream returns `PaintingMountResult` for its new `POST /paintings/mount` | PaintingMountService.test.ts (54) |
| image/dxt1.ts (127) | Pure-TS DXT1/BC1 opaque block encoder | CORE | identical | PaintingDds.test.ts (184) |
| image/paintingDds.ts (101) | `pngToPaintingDds`: sharp decode, resize to **512x512 `fit:'fill'`**, box-filter mips to 1x1, DXT1 DDS | CORE | identical | PaintingDds.test.ts |
| image/paintingInstanceId.ts (36) | FNV-1a64(uuid[:salt]) masked into `0x5353xxxxxxxxxxxx` texture instance ids | CORE | identical | PaintingRepository.test.ts |
| db/PaintingRepository.ts (49) + migration `010-create-painting-table` | `painting(uuid, instance_id, prompt, image BLOB, metadata, created_at)` in the per-save DB | CORE | identical | PaintingRepository.test.ts (152) |
| controllers/PaintingsController.ts (68) | `GET /paintings`, `/paintings/:id/texture`, `/paintings/:id/png` | CORE | **behind**: upstream adds `installMount` | PaintingsController.test.ts (69) |
| controllers/AIController.ts:44-54 | `POST /ai/v2/image/generate` (400 if no prompt) | CORE | (mixed file) | PaintingRepository.test.ts |
| services/AIService.ts:789-824 | `generateImage` + `storePaintingRecord` | CORE | (huge mixed file) | PaintingRepository.test.ts |
| controllers/AssetsController.ts (18) | `GET /files/:filename` serves `assets/<filename>` as image/png (Discord, Patreon, Google logos) | CORE | identical | none |
| controllers/FileController.ts (19) | `GET/DELETE /files/last-exception` (game lastException files for bug reports) | CORE | identical | none here |
| controllers/NewsController.ts (17) | `GET /announcements` proxies `https://www.sentientsimulations.com/announcements.json` (Gus's feed) | CORE (STREAM may hide) | identical | none |
| controllers/OptionsController.ts (68) | `GET /options/status`, `POST /options/fix`: reads/writes `<Sims 4>/Options.ini` (`modsdisabled=0`, `scriptmodsenabled=1`), setup wizard | CORE | identical | OptionsController.test.ts (111) |
| controllers/InteractionDescriptionController.ts (92) | Mapping browser: `/interactions` POST/DELETE (online), save-locally, local delete, ignored, all, semantic-search | CORE | fork adds the `NAMES_FROM_SAVE` 422 guard (keep: stops save names leaking into the shared DB) | InteractionService tests |
| controllers/UpdateController.ts (67) | `POST /update/mod`; refuses while game runs (auto → `skipped`) | CORE / **KILL** | identical | UpdateController.test.ts (115) |
| services/UpdateService.ts (206) | S3 download + extract into Mods/sentient-sims, stray sweep, mount, mac re-sign | CORE / **KILL** | identical | UpdateService.test.ts (215) |
| clients/UpdateClient.ts (11) | axios `POST {apiUrl}/update/mod` (used by renderer via SentientSimsAppClient) | CORE / **KILL** | identical | none |
| services/DirectoryService.ts | `SHIPPED_MOD_FILES`, `removeStrayModFiles`, `filesToDelete`, all mod paths | CORE | identical | yes |
| services/GameSigningService.ts | macOS only: ad-hoc codesign of the game exe (backup `.original`), `pkill` on update | CORE | - | - |
| src/renderer/PaintingsPanel.tsx | Paintings tab in ChatPage: manifest list, stored PNG, preview-only "Regenerate" (`format:'png'`) | CORE | **behind** by 61 lines (upstream's mount-install button) | none |
| src/renderer/ChatPage.tsx:121-148, 423 | Chat / Paintings tabs | mixed | - | - |
| src/renderer/components/AssetsImage.tsx, Announcements.tsx:129,267, PatreonComponent.tsx:31 | `/files/*.png` and `/announcements` consumers | CORE | - | none |
| src/renderer/UpdateComponent.tsx | "Mod Update" card: Update / Install / Reinstall + ReleaseTypeSelector | CORE / **KILL** | fork lacks upstream's "Sign in to install" state | none |
| src/renderer/providers/ModUpdateProvider.tsx | Single owner of check + install, **startup auto-install** | CORE / **KILL** | fork lacks upstream's sign-in snackbar | none |
| src/renderer/versions.ts | `isNewVersionAvailable`: S3 HeadObject, compares `Metadata.version` | CORE / **KILL** | comment-only delta | none |
| src/main/main.ts:214-218, 222-242 | Startup `ensureMount`; electron-updater | mixed | fork +60 lines | none |
| package.json:225-229, .github/workflows/publish.yml | electron-builder `publish: github guspuffygit/sentient-sims-app`; CI publish | CORE / **KILL** | - | - |

Settings keys: `imageProviderConfigs`, `defaultImageProviderConfigId`, `aiApiType`, `openaiKey` (+ env fallback), `openaiEndpoint` (image calls go to THIS endpoint), `generationTimeoutSeconds` (OpenAI client timeout), `geminiKeys` (random key per call), `accessToken`, `sentientSimsAIEndpoint`, `modsDirectory`, `modRelease` (`main`|`develop`, nightly gated on Patreon), `gameAppPath` (mac).
Dependencies: `sharp` 0.34.5 (native, `asarUnpack **/node_modules/@img/**`, also in release/app/package.json - a CORE build must keep both), `openai` 5, `@google/genai`, `@aws-sdk/client-s3`, `adm-zip`, `aws-amplify` (Cognito identity-pool credentials for S3), `electron-updater` 6.8.9.
Models: openai `gpt-image-1`/dall-e-3/dall-e-2; SSAI `google/gemini-3.1-flash-image`, `openai/gpt-5-image-mini`; Gemini list in constants.ts:128.

## 2. Painting generate -> store -> serve -> cache-heal

| Step | Where | Detail |
|---|---|---|
| Mod request | mod `SSPaintingService` | `POST /ai/v2/image/generate {prompt, format:'dds', size:'1024x1024', metadata}` (mod timeout 180 s) |
| Route | api.ts:30 -> AIController.ts:44-54 | 400 without prompt; `@CatchErrors` |
| Provider pick | AIService.ts:790 -> ImageProviderConfigService.ts:36-44 -> ApiContext.ts:765-779 | OpenAI / SentientSimsAI / Gemini; anything else throws "Image generation is not supported". **Not wrapped by `withExchangeLogging`** (ApiContext.ts:781): image calls never reach the ai_exchange log or cost reviews |
| Generate | AIService.ts:794-797 | `model = request.model ?? config.model`; returns base64 PNG (or whatever the provider returns) |
| PNG passthrough | AIService.ts:798-800 | `format !== 'dds'` returns provider bytes untouched (PaintingsPanel "Regenerate", older mods) - **not stored** |
| Store | AIService.ts:801-802, 811-824 -> PaintingRepository.ts:34-48 | Row in `{saveId}-sentient-sims.db` (per-save DB in Mods/sentient-sims) with the full PNG BLOB; instance id = `allocateTextureInstanceId` (paintingInstanceId.ts:29). No DB loaded -> logged, `textureInstanceId` omitted, mod falls back to a random session-only id |
| Encode | AIService.ts:803 -> paintingDds.ts:95 | 512x512 DXT1 DDS, 10 mips, returned base64 with `textureInstanceId` |
| Mod writes cache | mod `texture_store` | loose DDS into `Mods/sentient-sims/paintings/` (app never writes DDS files itself) |
| Serve manifest | api.ts:71 -> PaintingsController.ts:18-31 | `SELECT uuid, instance_id, prompt, metadata, created_at`; DB not loaded -> `[]` |
| Cache heal | api.ts:72 -> PaintingsController.ts:33-49 | Re-encodes the stored PNG to DDS on EVERY request (`{imageBase64}`); 404 if unknown |
| Renderer | api.ts:73 -> PaintingsController.ts:51-67; PaintingsPanel.tsx:34,191,213 | Raw PNG for the Paintings tab |

**Discrepancy to settle mod-side:** the mod map (section H) says the mod converts PNG->DDS in pure Python (A8R8G8B8). The app returns an already-encoded **DXT1** DDS whenever `format:'dds'` is sent. Either the Python encoder is a fallback for older apps or the map is stale; verify before cutting either side.

## 3. The paintings mount and who depends on it

`PaintingMountService.ensureMount()` (PaintingMountService.ts:38-49): `mkdir -p <modsDirectory>/sentient-sims/paintings`; if `<modsDirectory>/Resource.cfg` lacks `DirectoryFiles sentient-sims/paintings`, appends `Priority 500 / DirectoryFiles sentient-sims/paintings autoupdate / FileType 0x00b2d882 dds`; if the cfg is missing it first writes EA's vanilla `PackedFile` rules (else every .package mod would stop loading). Idempotent, never removes anything.
Callers: main.ts:215 (every app start) and UpdateService.ts:183 (after a mod install). Upstream 4.1.0 adds a third, `POST /paintings/mount` + a Paintings-panel button (a0546fb) - the fork does not have it.
The game reads Resource.cfg once at boot: a freshly added mount needs a game restart (the mod disables paintings until then).
**Dependents:** AI paintings (CORE) and the speaking-plumbob group-member texture override (STREAM; mod CLAUDE.md "reusing the paintings texture mount"). The active-Sim plumbob MODL ships in sentient-sims.package and does not need the mount. So the mount is CORE infrastructure that STREAM also leans on; it must not be tier-stripped.
**OneDrive hazard:** `modsDirectory` defaults to `%USERPROFILE%\Documents\Electronic Arts\The Sims 4\Mods` (SettingsService.ts:82-90), the NON-redirected Documents. On a OneDrive-redirected box the game reads the OneDrive Mods/Resource.cfg, so unless the player repoints `modsDirectory` the mount, DBs, mod-version.json and update extraction all land in a folder the game never reads. The mod resolves its own folder separately (non-redirected Documents for settings/logs per mod CLAUDE.md); whether `texture_store` writes under the SAME Mods root that holds the Resource.cfg the game reads must be checked mod-side (this box has the two-Mods-folders split).

## 4. Every path that downloads or overwrites mod files

All installs converge on ONE server route: **`POST /update/mod` (api.ts:56) -> UpdateController.updateMod (UpdateController.ts:24) -> UpdateService.updateMod/installMod (UpdateService.ts:67, 88)**. S3: `Bucket: 'sentient-sims-artifacts'`, `Key: sentient-sims-${modRelease}.zip` = **`sentient-sims-main.zip`** or **`sentient-sims-develop.zip`**, region us-east-1, credentials = the renderer's Cognito identity-pool session (`fetchAuthSession`), i.e. Gus's AWS account.

| # | Trigger | Code path | Gate |
|---|---|---|---|
| A | "Update now" button (HomePage card) | UpdateComponent.tsx:72-82 -> ModUpdateProvider.installUpdate (93-141) -> SentientSimsAppClient.update.updateMod (UpdateClient.ts:8) -> route | enabled only when `newVersionAvailable`; signed in; game closed |
| B | "Reinstall" button | UpdateComponent.tsx:86-97, same path | **always enabled once any mod-version.json exists**; signed in; game closed |
| C | First-run "Install" (setup wizard + HomePage) | SetupWizardModal.tsx:362 renders the same UpdateComponent; label flips to Install when mod version is `none` | as A |
| D | **Startup auto-install, unprompted** | ModUpdateProvider.tsx:147-171: first time `authStatus==='authenticated'` and `modRelease` loaded -> `checkForUpdates` -> `installUpdate({auto:true})` | runs when S3 `Metadata.version` **`!==`** local `mod-version.json` version (versions.ts:34, a string inequality, not "newer"); `none` counts, so it is also a silent first-run install. Skipped only if signed out or the game is running (UpdateController.ts:31-36) |
| - | Channel switch | same effect, re-check only | no install |
| - | Version check (read-only) | versions.ts:16-44 HeadObject same bucket/key | would still show "New version ready" |

What an install does (UpdateService.ts:88-205): download to `%TEMP%/sentient-sims-<uuid>.zip`; mkdir Mods and Mods/sentient-sims; extract every file FLAT into `Mods/sentient-sims/` with overwrite, skipping only `sentient-sims.ts4script` when `Mods/sentient-sims/Scripts/` exists (the dev junction), so **sentient-sims.package, ss_overlay.dll/.dylib, _ctypes.dylib and mod-version.json are still replaced**; `removeStrayModFiles` deletes any `SHIPPED_MOD_FILES` name anywhere else under Mods (DirectoryService.ts:14-22, 75-122; junctions are not walked); deletes `Mods/sentient-sims/sentient-sims-descriptions.ts4script` and `%TEMP%/sentient-sims.zip`; `ensureMount`; macOS `signGame` (pkills a running game, codesigns the exe).
Not install paths: the mod never triggers one, no websocket message or IPC handler does (checked ipcHandlers.ts). Other app writes into Mods/sentient-sims are data only (DBs, local_overrides/seen_unmapped JSON, animation overrides, semantic-search cache). OptionsController writes Options.ini.

**Why this matters for any fork build (not just STREAM):** the fork's mod-version.json will never equal Gus's S3 metadata, so path D fires on every app start with a signed-in player and the game closed, and puts Gus's package and overlay DLL over the fork's (losing moodlet tiers, the plumbob MODL, the fork overlay). A dev box whose Mods/sentient-sims has no mod-version.json reads as `none` and is treated the same.
**One-place kill switch:** a build flag checked in UpdateController.updateMod (returns `{skipped:'disabled'}`) stops A-D server-side; then hide UpdateComponent (HomePage.tsx:108, SetupWizardModal.tsx:362) and make ModUpdateProvider's effect and `checkForUpdates` no-ops so versions.ts never calls S3. Keep `ensureMount` at main.ts:215, which already covers what the post-install call did.

## 5. App self-updater (electron-updater)

main.ts:222-242: `autoUpdater.checkForUpdatesAndNotify()` at every start; on `update-downloaded` a one-button dialog ("Install and Restart") whose promise resolves on ANY close and then calls `quitAndInstall()`. electron-updater's default `autoInstallOnAppQuit=true` also installs on the next normal quit. Feed: `app-update.yml`, which electron-builder generates from `build.publish` = `github guspuffygit/sentient-sims-app` (package.json:225-229) even with `--publish never`.
**A packaged fork build WILL update itself from Gus's releases:** fork is 4.0.8, upstream has 4.1.0, so the first launch downloads 4.1.0 and replaces the fork in place (same `appId com.sentientsimulations.sentientsimsapp`, same productName `SentientSims`, so the same install dir and userData/settings). Unpacked dev runs (`npm run start`) skip the check. Windows NSIS applies it (no publisherName pinning); macOS would fail signature validation on an unsigned fork.
Fixes for fork builds: set `build.publish` to the fork's repo (or `null`) AND guard the main.ts block with a build flag; bump the version off 4.0.x; consider a distinct appId/productName so a fork install and an upstream install cannot overwrite each other.
publish.yml: on push to `main`/`develop` it runs `electron-builder --publish always` with `GITHUB_TOKEN`; in Scott-Bott/sentient-sims-app-lab that token cannot write to guspuffygit's repo (fails at upload, burns 3-OS CI minutes; the mac job needs Apple secrets). The workflow never touches the S3 bucket; the mod zip in S3 is published from the mod side.

## 6. Bugs and risks (not fixed)

1. **(critical, fork)** Path D silently replaces the fork's mod on app start (section 4).
2. **(critical, fork)** Self-updater replaces the fork app with Gus's 4.1.0 (section 5).
3. AssetsController.ts:12-17: `filename` goes straight into `path.join(RESOURCES_PATH, filename)` (Express decodes `%2F`, so `..%2F..` probably traverses; unverified) with no try/catch; api.ts:146 `listen(port)` binds all interfaces, so `/files`, `/options/fix` and the rest are reachable from the LAN if the firewall allows.
4. Image generation bypasses AIExchangeLogService (ApiContext.ts:765 vs 781): painting spend is invisible to the stream cost reviews.
5. OpenAI images go to `openaiEndpoint` (OpenAIService.ts:31, 66-69). With that pointed at OpenRouter/Groq/local, paintings fail; Auto falls back to OpenAI and throws "No OpenAI Key" when no image-capable provider has credentials.
6. SSAI and Gemini ignore `size`; non-square output is stretched by `fit:'fill'` (paintingDds.ts:97).
7. The full PNG (roughly 1-3 MB) is stored per painting in the per-save DB, which DbService copies on every `/db/save` (the call that blocks the game's save).
8. `pngToPaintingDds`'s DXT1 encode is synchronous JS on the main-process event loop (512x512 plus mips) at generate time and on every `/texture` heal, which stalls websocket/HTTP for that time; a heal of N paintings means N stalls.
9. Manifest and texture errors come back as HTTP 200 `{error}` (PaintingsController.ts:29, 47); only the 404 is a real status.
10. PaintingsPanel "Regenerate" is preview-only (`format:'png'`, never stored, cannot reach the game); `onGenerated` reloads an unchanged manifest.
11. No DB loaded at generate time: the texture is session-only and a heal can never restore it.
12. The Reinstall button is always live, and `removeStrayModFiles` deletes any second copy of shipped files under Mods (such as a side-by-side dev folder).
13. NewsController shows Gus's announcements (possibly "update your mod") in a fork build; a fetch failure returns 500 into the home page.
14. The fork is behind upstream 4.1.0 on the mount route/button, the "Sign in to install" UX and the sign-in snackbar; a CORE cut should take upstream's versions of PaintingMountService, PaintingsController, PaintingsPanel, UpdateComponent and ModUpdateProvider.

## 7. What a CORE build must keep / surgery for mixed files

Keep whole: ImageGenerationService, ImageProviderConfigService, OpenAIImageGenerationService, image/*, PaintingRepository + migration 010, PaintingsController, PaintingMountService (upstream 4.1.0 variants), AssetsController, FileController, OptionsController, NewsController, InteractionDescriptionController (with the NAMES_FROM_SAVE guard), PaintingsPanel, the provider-config UI for images (renderer/settings/ProviderConfigsComponent.tsx:41-103), sharp packaging, and the routes api.ts:30, 44-46, 56, 71-73 (+ upstream's `/paintings/mount`), 103-118, 124-127.
Surgery:
- **AIService.ts:789-824**: `generateImage`/`storePaintingRecord` sit inside the mixed AIService; carry them intact (or lift them into a PaintingService).
- **GeminiService / SentientSimsAIService**: the image methods ride on the text providers; CORE keeps both classes anyway.
- **ApiContext.ts**: keep `getImageGenerationService` (765-779), `paintingRepository`, `paintingMount`, `imageProviderConfigs`, `update`, `gameSigning`; optionally wrap image services in exchange logging.
- **main.ts**: keep 214-218 (mount); put 222-242 (autoUpdater) behind a build flag that is ON only for Gus-published builds.
- **Updater set** (UpdateController/Service/Client, UpdateComponent, ModUpdateProvider, versions.ts, publish config): CORE for Gus's own releases, **KILL** in every Scott-built tier (STREAM, AUTONOMY, DEV) through the one flag in section 4. UpdateService's post-install `ensureMount`/`signGame` need no replacement (startup covers both).
- **ChatPage.tsx**: the Paintings tab is CORE; whatever else ChatPage carries is outside this section.
