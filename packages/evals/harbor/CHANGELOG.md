# Changelog

## [0.13.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.12.0...introspection-harbor-v0.13.0) (2026-10-29)


### Features

* **harbor:** serve a Recipe as an ACP target for simulated-user chains ([#656](https://github.com/introspection-org/introspection-cli/issues/656)) ([f4a9bcb](https://github.com/introspection-org/introspection-cli/commit/f4a9bcb885d00552edf9084091a387c186d16df0))


### Bug Fixes

* **harbor:** write the target's trajectory in simulated-user trials ([#657](https://github.com/introspection-org/introspection-cli/issues/657)) ([720fb4b](https://github.com/introspection-org/introspection-cli/commit/720fb4bb34f9e4ec08b17250be01f94616cc4564))

## [0.12.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.11.0...introspection-harbor-v0.12.0) (2026-10-28)


### Features

* **cli:** share CI reports and publish offline judgement results ([#646](https://github.com/introspection-org/introspection-cli/issues/646)) ([28ffa32](https://github.com/introspection-org/introspection-cli/commit/28ffa327b9f73300fb38ac8de8358814a7300433))
* **eval:** run a plane Harbor trial on a service credential alone by pinning --runtime-version ([#636](https://github.com/introspection-org/introspection-cli/issues/636)) ([3b1cee1](https://github.com/introspection-org/introspection-cli/commit/3b1cee196dc22a1bca2cb95aa1545a561212127e))


### Bug Fixes

* **harbor:** accept declared candidate models in native mode ([#648](https://github.com/introspection-org/introspection-cli/issues/648)) ([ced1e8b](https://github.com/introspection-org/introspection-cli/commit/ced1e8b84fceb5d1e11f35483724a2fe060aefa0))
* **harbor:** retain eval tasks by archiving on cleanup ([#645](https://github.com/introspection-org/introspection-cli/issues/645)) ([3642614](https://github.com/introspection-org/introspection-cli/commit/3642614132e9795981c829e05350a4afef573c2e))

## [0.11.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.10.0...introspection-harbor-v0.11.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* **harbor:** `introspection_harbor.client` (`DataPlaneClient`, `ControlPlaneClient`, `pull_reference`) is removed: the Introspection environment calls the platform through `introspection-sdk` 0.33.0 or later, on the member's CLI login.

### Features

* **harbor:** read MCP fakes' answers and one server's calls in a verifier ([#620](https://github.com/introspection-org/introspection-cli/issues/620)) ([0088438](https://github.com/introspection-org/introspection-cli/commit/0088438b5a908db3e961d1f0c81b4c10e4420cd6))
* **harbor:** run a Pi Recipe on the host as a Harbor user agent ([#626](https://github.com/introspection-org/introspection-cli/issues/626)) ([47a02d0](https://github.com/introspection-org/introspection-cli/commit/47a02d0f758a4ae67a226f59a4c59a0498815a07))
* **harbor:** run each step as a task run with the introspection-native agent ([#635](https://github.com/introspection-org/introspection-cli/issues/635)) ([3e65d09](https://github.com/introspection-org/introspection-cli/commit/3e65d097be10178f7b0fb3db8bb42718d84f9c22))


### Bug Fixes

* **harbor:** create /logs/agent and /logs/verifier before an in-cluster trial's agent runs ([#568](https://github.com/introspection-org/introspection-cli/issues/568)) ([5a48b63](https://github.com/introspection-org/introspection-cli/commit/5a48b6363209933d07e87140ab335a7970210678))

## [0.10.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.9.0...introspection-harbor-v0.10.0) (2026-10-15)


### Features

* **harbor:** verifier helpers for a Recipe's MCP fakes ([#520](https://github.com/introspection-org/introspection-cli/issues/520)) ([2389374](https://github.com/introspection-org/introspection-cli/commit/2389374a4024bc44554fb8cd20aa153e8feedb4e))
* **proxy:** send proxy-native sessions through the env proxy ([#499](https://github.com/introspection-org/introspection-cli/issues/499)) ([7ffc16d](https://github.com/introspection-org/introspection-cli/commit/7ffc16d8918a79873422023d71ed898e1947174b))

## [0.9.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.8.0...introspection-harbor-v0.9.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **harbor:** a Harbor trial needs Recipes 0.33.0 or later in its image, the first release that writes a run's GenAI spans to the file named by PI_RECIPE_GENAI_SPANS_FILE. A runtime whose image was baked on an older base fails after the agent run until a new version is baked. A bootstrapped image gets a current Recipes from `introspection setup`.

### Features

* **eval:** continue the Pi session across Harbor steps ([#458](https://github.com/introspection-org/introspection-cli/issues/458)) ([b746181](https://github.com/introspection-org/introspection-cli/commit/b746181d7715bbbc01eb22e357ec7c359b594d3c))
* **eval:** retry Harbor trials that failed on infrastructure ([#489](https://github.com/introspection-org/introspection-cli/issues/489)) ([ff11ce1](https://github.com/introspection-org/introspection-cli/commit/ff11ce1e2d287154fe0441e47cddcae2ffcdf2b6))
* **harbor:** add verifier helpers for reading the trajectory ([#482](https://github.com/introspection-org/introspection-cli/issues/482)) ([bda80d3](https://github.com/introspection-org/introspection-cli/commit/bda80d3d550e3a29f51c6d35ce248b32de8d75b7))
* **harbor:** bind the MCP servers a task declares ([#480](https://github.com/introspection-org/introspection-cli/issues/480)) ([7bb00c0](https://github.com/introspection-org/introspection-cli/commit/7bb00c0b5c5b8fc6391088d4a425f3fba519a701))
* **harbor:** build the trajectory from the platform's ATIF projection ([fef6c2e](https://github.com/introspection-org/introspection-cli/commit/fef6c2e9538571ed3efc16e717cb087d90f25d3f))
* **harbor:** record a failed tool call in the ATIF trajectory ([#478](https://github.com/introspection-org/introspection-cli/issues/478)) ([fb8a2b3](https://github.com/introspection-org/introspection-cli/commit/fb8a2b3e321ac38646b6a509aa45a2badfee6a41))
* **harbor:** write the whole conversation to a continued step's trajectory ([#476](https://github.com/introspection-org/introspection-cli/issues/476)) ([9510c48](https://github.com/introspection-org/introspection-cli/commit/9510c48746baf028b1a4bed4ea9763bd36e3179f))
* **local:** keep a replayed session in the --session-dir passed to Pi ([fef6c2e](https://github.com/introspection-org/introspection-cli/commit/fef6c2e9538571ed3efc16e717cb087d90f25d3f))


### Bug Fixes

* **harbor:** keep Pi's subcommands first in the trial's pi launcher ([#502](https://github.com/introspection-org/introspection-cli/issues/502)) ([13744ab](https://github.com/introspection-org/introspection-cli/commit/13744ab33cc19949a9198a673a259eb935977956))
* **harbor:** route a verifier's model calls through managed egress ([#464](https://github.com/introspection-org/introspection-cli/issues/464)) ([63e24dd](https://github.com/introspection-org/introspection-cli/commit/63e24dd4f783f8b9c10ed6ed080ce2799ef587b4))
* **local:** resolve a relative replay --session-dir where Pi starts ([fef6c2e](https://github.com/introspection-org/introspection-cli/commit/fef6c2e9538571ed3efc16e717cb087d90f25d3f))

## [0.8.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.7.2...introspection-harbor-v0.8.0) (2026-09-28)


### Features

* **eval:** select a runner's own agent with --agent harbor:oracle, and refuse an unpushed plane trial ([#439](https://github.com/introspection-org/introspection-cli/issues/439)) ([050c505](https://github.com/introspection-org/introspection-cli/commit/050c505e54064f2fefd91d6928c0223ecd495338))

## [0.7.2](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.7.1...introspection-harbor-v0.7.2) (2026-09-19)


### Bug Fixes

* **eval:** use repository URL for committed checkout ([#404](https://github.com/introspection-org/introspection-cli/issues/404)) ([54a2cf1](https://github.com/introspection-org/introspection-cli/commit/54a2cf12ff3927e3ced7acfac05d01b7addd6c0f))

## [0.7.1](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.7.0...introspection-harbor-v0.7.1) (2026-09-15)


### Bug Fixes

* **harbor:** skip mounted archive root metadata ([#400](https://github.com/introspection-org/introspection-cli/issues/400)) ([8d14a61](https://github.com/introspection-org/introspection-cli/commit/8d14a61e922b51068407999f76cb834c66514c1e))

## [0.7.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.6.0...introspection-harbor-v0.7.0) (2026-09-14)


### Features

* **evals:** run Harbor at exact Recipe commits ([#394](https://github.com/introspection-org/introspection-cli/issues/394)) ([f4d86b3](https://github.com/introspection-org/introspection-cli/commit/f4d86b3b812047e3a7723159535c26c74854ca8c))


### Bug Fixes

* **harbor:** preserve mounted directory metadata ([#398](https://github.com/introspection-org/introspection-cli/issues/398)) ([7b0bbb7](https://github.com/introspection-org/introspection-cli/commit/7b0bbb761258ff5394e6946367fe32e5589a6cee))

## [0.6.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.5.2...introspection-harbor-v0.6.0) (2026-09-10)


### Features

* **harbor:** support exact runtime pins ([#391](https://github.com/introspection-org/introspection-cli/issues/391)) ([58b8e42](https://github.com/introspection-org/introspection-cli/commit/58b8e42b7f379e7f33e0b0791da0fac3760fda93))


### Bug Fixes

* **harbor:** fail trials on terminal provider errors ([#364](https://github.com/introspection-org/introspection-cli/issues/364)) ([2434669](https://github.com/introspection-org/introspection-cli/commit/2434669f2de081a578eb0430bc7df88b27cd2115))

## [0.5.2](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.5.1...introspection-harbor-v0.5.2) (2026-09-09)


### Bug Fixes

* **harbor:** inherit child task credentials ([#380](https://github.com/introspection-org/introspection-cli/issues/380)) ([4a55521](https://github.com/introspection-org/introspection-cli/commit/4a555216bc1e4ab249ad555a673b7daed65d6e15))
* **harbor:** load provider HTTP compatibility in Pi ([#381](https://github.com/introspection-org/introspection-cli/issues/381)) ([840381f](https://github.com/introspection-org/introspection-cli/commit/840381f3ef0919001029a35f48533329d118a0b6))

## [0.5.1](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.5.0...introspection-harbor-v0.5.1) (2026-09-08)


### Bug Fixes

* **harbor:** install pi launcher as agent ([#373](https://github.com/introspection-org/introspection-cli/issues/373)) ([ac28d4e](https://github.com/introspection-org/introspection-cli/commit/ac28d4ee27a453d16d334e1edb038245df982450))
* **harbor:** run main commands with bash ([#374](https://github.com/introspection-org/introspection-cli/issues/374)) ([1520d5b](https://github.com/introspection-org/introspection-cli/commit/1520d5bb52ca583767741f601d0d7dab9035e72d))

## [0.5.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.7...introspection-harbor-v0.5.0) (2026-09-07)


### Features

* **harbor:** the bootstrap adapter, and running a trial in an Introspection eval task sandbox ([#368](https://github.com/introspection-org/introspection-cli/issues/368)) ([84e361d](https://github.com/introspection-org/introspection-cli/commit/84e361d50ff145f5acab2724279cf08d1d65b86d))


### Bug Fixes

* **cli:** keep the empty-result note off stdout, and de-duplicate the recipe dir ([#362](https://github.com/introspection-org/introspection-cli/issues/362)) ([cbf7ffc](https://github.com/introspection-org/introspection-cli/commit/cbf7ffc90ecbbde629a9ef5eb52adeeac845fa19))

## [0.4.7](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.6...introspection-harbor-v0.4.7) (2026-09-04)


### Bug Fixes

* **harbor:** preload managed evaluation telemetry ([#351](https://github.com/introspection-org/introspection-cli/issues/351)) ([dd698c2](https://github.com/introspection-org/introspection-cli/commit/dd698c2f09a8225ea0b71ee7624d71b331416fb7))

## [0.4.6](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.5...introspection-harbor-v0.4.6) (2026-09-03)


### Bug Fixes

* **harbor:** route managed model calls through egress ([#337](https://github.com/introspection-org/introspection-cli/issues/337)) ([28e374e](https://github.com/introspection-org/introspection-cli/commit/28e374ea97dd2b5c9711c7f5aa1d2b5343bf93d0))

## [0.4.5](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.4...introspection-harbor-v0.4.5) (2026-09-03)


### Bug Fixes

* **harbor:** preserve egress proxy for direct Pi runs ([#336](https://github.com/introspection-org/introspection-cli/issues/336)) ([651d0da](https://github.com/introspection-org/introspection-cli/commit/651d0da3727af215b11590b1c95c1e8e742f1b2b))
* **harbor:** publish with uv build ([#333](https://github.com/introspection-org/introspection-cli/issues/333)) ([297e5ee](https://github.com/introspection-org/introspection-cli/commit/297e5eeeb8f0b6713db56e765c9b4a41fb670ad9))

## [0.4.4](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.3...introspection-harbor-v0.4.4) (2026-09-03)


### Bug Fixes

* **harbor:** sync 0.4.3 lockfile ([#331](https://github.com/introspection-org/introspection-cli/issues/331)) ([c20a7fd](https://github.com/introspection-org/introspection-cli/commit/c20a7fdb949ea8edd2ddc864326c60fe57df50c4))

## [0.4.3](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.2...introspection-harbor-v0.4.3) (2026-09-03)


### Bug Fixes

* **harbor:** sync 0.4.2 lockfile ([#329](https://github.com/introspection-org/introspection-cli/issues/329)) ([3fee5d4](https://github.com/introspection-org/introspection-cli/commit/3fee5d4f94bfa2603ba2a1ffb6a047cbd043bb7f))

## [0.4.2](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.1...introspection-harbor-v0.4.2) (2026-09-03)


### Bug Fixes

* **setup:** accept supported Harbor Python versions ([#326](https://github.com/introspection-org/introspection-cli/issues/326)) ([e40b97a](https://github.com/introspection-org/introspection-cli/commit/e40b97af30738b11cf851b5534e86aba2a3dca44))

## [0.4.1](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.4.0...introspection-harbor-v0.4.1) (2026-09-02)


### Bug Fixes

* **harbor:** forward relay target to E2B ([#319](https://github.com/introspection-org/introspection-cli/issues/319)) ([459f969](https://github.com/introspection-org/introspection-cli/commit/459f96956a51f4c675efb7558636cd52a45544fb))

## [0.4.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.3.1...introspection-harbor-v0.4.0) (2026-09-02)


### Features

* **bindings:** authenticate MCP with connectors ([#318](https://github.com/introspection-org/introspection-cli/issues/318)) ([59052fb](https://github.com/introspection-org/introspection-cli/commit/59052fbbbd5b1973793fa61837495ed605e52e4e))
* **eval:** add Vitest runner and reusable Recipe judges ([#297](https://github.com/introspection-org/introspection-cli/issues/297)) ([172f2f6](https://github.com/introspection-org/introspection-cli/commit/172f2f6298cde96a0db56f0985d3f87ebd5002f3))

## [0.3.1](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.3.0...introspection-harbor-v0.3.1) (2026-09-02)


### Bug Fixes

* **harbor:** run staged recipes with direct MCP auth ([#299](https://github.com/introspection-org/introspection-cli/issues/299)) ([9a671e9](https://github.com/introspection-org/introspection-cli/commit/9a671e9bd5fc92b99587e5c83ae03abc0d3751ad))

## [0.3.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.2.0...introspection-harbor-v0.3.0) (2026-09-01)


### Features

* **harbor:** run E2B through scoped Data Plane egress ([#287](https://github.com/introspection-org/introspection-cli/issues/287)) ([0ca3b63](https://github.com/introspection-org/introspection-cli/commit/0ca3b63240a235476f5f97e2392afd8d9e7520a5))

## [0.2.0](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.1.3...introspection-harbor-v0.2.0) (2026-08-12)


### Features

* **eval:** replay production conversations by turn ([#239](https://github.com/introspection-org/introspection-cli/issues/239)) ([10ae0d1](https://github.com/introspection-org/introspection-cli/commit/10ae0d1458b361d4fd0ffa4ef3205228d7f5a8c8))

## [0.1.3](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.1.2...introspection-harbor-v0.1.3) (2026-08-11)


### Bug Fixes

* **eval:** use agent YAML as model authority ([#228](https://github.com/introspection-org/introspection-cli/issues/228)) ([c2ed704](https://github.com/introspection-org/introspection-cli/commit/c2ed704c32ce2237cf770549b56d3f3adf1e9e1e))

## [0.1.2](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.1.1...introspection-harbor-v0.1.2) (2026-08-11)


### Bug Fixes

* **eval:** repair Harbor evaluation flow ([#223](https://github.com/introspection-org/introspection-cli/issues/223)) ([475515e](https://github.com/introspection-org/introspection-cli/commit/475515e295ba72411f9748d287fbc9747aad5810))

## [0.1.1](https://github.com/introspection-org/introspection-cli/compare/introspection-harbor-v0.1.0...introspection-harbor-v0.1.1) (2026-08-10)


### Bug Fixes

* **harbor:** preserve task working directory ([#216](https://github.com/introspection-org/introspection-cli/issues/216)) ([e60c165](https://github.com/introspection-org/introspection-cli/commit/e60c165944c66ab78882bb63752d0a29934b660c))

## 0.1.0 (2026-08-08)


### Features

* **cli:** add local Recipe evaluations ([#203](https://github.com/introspection-org/introspection-cli/issues/203)) ([b14d97a](https://github.com/introspection-org/introspection-cli/commit/b14d97a13d5ebe3c805df6321ad4d5b89788a082))
