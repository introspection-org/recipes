# Changelog

## [0.25.0](https://github.com/introspection-org/recipes/compare/v0.24.0...v0.25.0) (2026-09-07)


### Features

* **slack:** register issue thread routing after channel sends ([#261](https://github.com/introspection-org/recipes/issues/261)) ([19c8987](https://github.com/introspection-org/recipes/commit/19c89870bc756e8a37d64212e7c9fb91239fb131))

## [0.24.0](https://github.com/introspection-org/recipes/compare/v0.23.0...v0.24.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **channels:** Slack thread reads start with the oldest page and paginate forward rather than starting with the latest page and paginating backward.

### Features

* **channels:** unify channel commands and explicit targets ([#255](https://github.com/introspection-org/recipes/issues/255)) ([81e5f00](https://github.com/introspection-org/recipes/commit/81e5f003a4ef554ffd63786e26dcceb34f1015e5))


### Bug Fixes

* **channels:** require inbound replies by default ([#258](https://github.com/introspection-org/recipes/issues/258)) ([ff4696a](https://github.com/introspection-org/recipes/commit/ff4696a63aa9fef9f20b3d72a86fc1fd393217b9))

## [0.23.0](https://github.com/introspection-org/recipes/compare/v0.22.1...v0.23.0) (2026-09-02)


### Features

* load persistent memory context into Recipe sessions ([#250](https://github.com/introspection-org/recipes/issues/250)) ([24c7108](https://github.com/introspection-org/recipes/commit/24c7108faddb3ea8875b74e6014aa481a6e3bb5f))

## [0.22.1](https://github.com/introspection-org/recipes/compare/v0.22.0...v0.22.1) (2026-09-01)


### Bug Fixes

* **channels:** guide channel response delivery ([#248](https://github.com/introspection-org/recipes/issues/248)) ([cf4335e](https://github.com/introspection-org/recipes/commit/cf4335e53b58129d7f8a8a326af04f889b6fbdf5))
* **release:** keep temporary npm tags ([#245](https://github.com/introspection-org/recipes/issues/245)) ([f595c3a](https://github.com/introspection-org/recipes/commit/f595c3abb8ee6feef99400fc98c41100d3ebca61))
* **release:** publish workspace channel package ([#243](https://github.com/introspection-org/recipes/issues/243)) ([0d147a3](https://github.com/introspection-org/recipes/commit/0d147a3ce4bdab58c8d25015d608d9f554ba1b7f))

## [0.22.0](https://github.com/introspection-org/recipes/compare/v0.21.0...v0.22.0) (2026-08-31)


### Features

* add Slack Bot API tools to Recipes ([#233](https://github.com/introspection-org/recipes/issues/233)) ([3944dac](https://github.com/introspection-org/recipes/commit/3944dacfa6d69043b45cf359b6aa6a2276b1e568))
* **channels:** provider-neutral channel_* tools bound to the task's conversation ([#234](https://github.com/introspection-org/recipes/issues/234)) ([f49a194](https://github.com/introspection-org/recipes/commit/f49a1948d3a9e7df5d9f2e6194e577a5350511cb))


### Bug Fixes

* **release:** accept prepared manifest state ([#242](https://github.com/introspection-org/recipes/issues/242)) ([0e5d0d9](https://github.com/introspection-org/recipes/commit/0e5d0d9dd735f24abdde2d20f5f78239b21e9b57))
* **release:** make grouped releases parseable ([#241](https://github.com/introspection-org/recipes/issues/241)) ([931ed38](https://github.com/introspection-org/recipes/commit/931ed38e6cc9c316950be3a92fcc8dc539854089))

## [0.21.0](https://github.com/introspection-org/recipes/compare/v0.20.0...v0.21.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* recipes are no longer validated when a Pi session starts. Authors get diagnostics from the CLI, and the platform blocks invalid recipes at task creation.

### Features

* stop vendoring native binaries — drop the session-start validator, ship mcp-client per platform ([#229](https://github.com/introspection-org/recipes/issues/229)) ([40b5ff5](https://github.com/introspection-org/recipes/commit/40b5ff58a8fd8828d35bda4347e821c0438dd063))


### Bug Fixes

* Propagate child-agent provider errors ([#228](https://github.com/introspection-org/recipes/issues/228)) ([4a2d5c3](https://github.com/introspection-org/recipes/commit/4a2d5c38a6481d84634fb048bd3dbb0682e66dca))

## [0.20.0](https://github.com/introspection-org/recipes/compare/v0.19.3...v0.20.0) (2026-08-20)


### Features

* expose scoped child agent events ([#224](https://github.com/introspection-org/recipes/issues/224)) ([c3d3b9d](https://github.com/introspection-org/recipes/commit/c3d3b9d7d5ec64aeabb0cd0a9de01ffc7d925a43))


### Bug Fixes

* support Pi 0.84.2 ([#218](https://github.com/introspection-org/recipes/issues/218)) ([846314f](https://github.com/introspection-org/recipes/commit/846314f571733eefcc623daceb0042d462dee8e5))

## [0.19.3](https://github.com/introspection-org/recipes/compare/v0.19.2...v0.19.3) (2026-08-13)


### Bug Fixes

* preserve MCP HTTP fetch overrides ([#216](https://github.com/introspection-org/recipes/issues/216)) ([8706a3c](https://github.com/introspection-org/recipes/commit/8706a3cde589948a2c1bbab4424b92cae26e49ca))

## [0.19.2](https://github.com/introspection-org/recipes/compare/v0.19.1...v0.19.2) (2026-08-12)


### Bug Fixes

* share recipe extension context across instances ([#214](https://github.com/introspection-org/recipes/issues/214)) ([1b9031a](https://github.com/introspection-org/recipes/commit/1b9031ae36cd31808c0f6a27edc7fd92095ffcfa))

## [0.19.1](https://github.com/introspection-org/recipes/compare/v0.19.0...v0.19.1) (2026-08-10)


### Bug Fixes

* avoid redundant npm access mutation ([#213](https://github.com/introspection-org/recipes/issues/213)) ([cefde86](https://github.com/introspection-org/recipes/commit/cefde868724c6c444e4c6e2b024a4346d1d0a81a))
* complete provider policy support ([#212](https://github.com/introspection-org/recipes/issues/212)) ([e2a3fca](https://github.com/introspection-org/recipes/commit/e2a3fcaef04f12f6ec426a876464e6ea68d241aa))
* recover checker release train ([#209](https://github.com/introspection-org/recipes/issues/209)) ([b05f299](https://github.com/introspection-org/recipes/commit/b05f2993d500d2402a6db8aa1a67ff07278305e4))

## [0.19.0](https://github.com/introspection-org/recipes/compare/v0.18.1...v0.19.0) (2026-08-10)


### Features

* add transparent AI and session configuration ([#208](https://github.com/introspection-org/recipes/issues/208)) ([a86a08d](https://github.com/introspection-org/recipes/commit/a86a08d74d053afc991a1bc7fc977892a29bf4e5))


### Bug Fixes

* propagate trace context per MCP call ([#201](https://github.com/introspection-org/recipes/issues/201)) ([001e83e](https://github.com/introspection-org/recipes/commit/001e83e59ba68dcb16d22bdc5058a50d3b7ed85b))

## [0.18.1](https://github.com/introspection-org/recipes/compare/v0.18.0...v0.18.1) (2026-08-06)


### Bug Fixes

* preserve complete session telemetry ([#198](https://github.com/introspection-org/recipes/issues/198)) ([41bb6c9](https://github.com/introspection-org/recipes/commit/41bb6c9f2fc06443f01b85ca7bd99ffede565eef))

## [0.18.0](https://github.com/introspection-org/recipes/compare/v0.17.1...v0.18.0) (2026-08-05)


### Features

* support multi-select interactions ([#196](https://github.com/introspection-org/recipes/issues/196)) ([acedb10](https://github.com/introspection-org/recipes/commit/acedb10e3db507ca31a09a997e61cea58ece2acd))

## [0.17.1](https://github.com/introspection-org/recipes/compare/v0.17.0...v0.17.1) (2026-08-04)


### Bug Fixes

* exclude local MCP config from recipe validation ([#194](https://github.com/introspection-org/recipes/issues/194)) ([4e205c0](https://github.com/introspection-org/recipes/commit/4e205c049ed2098cc0aecb232a34f68d6fb2f21f))

## [0.17.0](https://github.com/introspection-org/recipes/compare/v0.16.1...v0.17.0) (2026-08-03)


### Features

* align judge identity with recipe names ([#190](https://github.com/introspection-org/recipes/issues/190)) ([166c40d](https://github.com/introspection-org/recipes/commit/166c40d4a10a274d163873326f054ffccad4a652))

## [0.16.1](https://github.com/introspection-org/recipes/compare/v0.16.0...v0.16.1) (2026-07-30)


### Bug Fixes

* isolate release please train labels ([#159](https://github.com/introspection-org/recipes/issues/159)) ([280c2c0](https://github.com/introspection-org/recipes/commit/280c2c0b7da5396e456e67feb845d3e481c60baf))
* preserve string MCP call arguments ([#158](https://github.com/introspection-org/recipes/issues/158)) ([43f8c43](https://github.com/introspection-org/recipes/commit/43f8c43dfb65c4f27d976a8b8e1a25e56da705da))

## [0.16.0](https://github.com/introspection-org/recipes/compare/v0.15.0...v0.16.0) (2026-07-28)


### Features

* publish introspection recipe checker ([#153](https://github.com/introspection-org/recipes/issues/153)) ([b8be591](https://github.com/introspection-org/recipes/commit/b8be5914aa05ecb144110cd4f6831222cd79c7b5))

## [0.15.0](https://github.com/introspection-org/recipes/compare/v0.14.2...v0.15.0) (2026-07-27)


### Features

* declare portable runtime requirements ([#151](https://github.com/introspection-org/recipes/issues/151)) ([ad91ed6](https://github.com/introspection-org/recipes/commit/ad91ed680bace8d059b57c89a364a959f02aa7b1))

## [0.14.2](https://github.com/introspection-org/recipes/compare/v0.14.1...v0.14.2) (2026-07-27)


### Bug Fixes

* allow blank agent system instructions ([#148](https://github.com/introspection-org/recipes/issues/148)) ([b279365](https://github.com/introspection-org/recipes/commit/b2793651b7e3830f38b5959e0c3f948eda6b92be))

## [0.14.1](https://github.com/introspection-org/recipes/compare/v0.14.0...v0.14.1) (2026-07-27)


### Bug Fixes

* **recipe-check:** restore portable validation contracts ([#143](https://github.com/introspection-org/recipes/issues/143)) ([fdb065e](https://github.com/introspection-org/recipes/commit/fdb065e6967781742965670e1aba3e3a864b0ca6))

## [0.14.0](https://github.com/introspection-org/recipes/compare/v0.13.0...v0.14.0) (2026-07-27)


### ⚠ BREAKING CHANGES

* define the portable Recipe session boundary ([#132](https://github.com/introspection-org/recipes/issues/132))

### Features

* add MCP tools mode with deferred discovery ([#129](https://github.com/introspection-org/recipes/issues/129)) ([82a270c](https://github.com/introspection-org/recipes/commit/82a270c92c9fe4bc23b1b73abe03dc6480a20eb8))
* establish portable Recipe validation ([#138](https://github.com/introspection-org/recipes/issues/138)) ([3c14388](https://github.com/introspection-org/recipes/commit/3c14388eabbbc2f09cb33a0858f70ca443e618cb))
* finalize the portable Recipes API and checker ([#142](https://github.com/introspection-org/recipes/issues/142)) ([fc56118](https://github.com/introspection-org/recipes/commit/fc561181c204b3d5e54d39339c0a1eb445ac6312))


### Bug Fixes

* apply host MCP environment to bash ([#141](https://github.com/introspection-org/recipes/issues/141)) ([a472975](https://github.com/introspection-org/recipes/commit/a472975e1f5af59181591052e2dcc4a6822ae64b))
* keep releases on pre-1 feature increments ([#135](https://github.com/introspection-org/recipes/issues/135)) ([e165fd8](https://github.com/introspection-org/recipes/commit/e165fd8899498a733f97e2c4ea5f69f3865c5180))


### Code Refactoring

* define the portable Recipe session boundary ([#132](https://github.com/introspection-org/recipes/issues/132)) ([86de676](https://github.com/introspection-org/recipes/commit/86de67668d9066dcf00303cf394d752a7c67a427))

## [0.13.0](https://github.com/introspection-org/pi-recipes/compare/v0.12.0...v0.13.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* define Recipes as the open format and portable runtime for Pi agents ([#130](https://github.com/introspection-org/pi-recipes/issues/130))

### Features

* define Recipes as the open format and portable runtime for Pi agents ([#130](https://github.com/introspection-org/pi-recipes/issues/130)) ([bee99ed](https://github.com/introspection-org/pi-recipes/commit/bee99edaf26489131d96fb28d313f3d5c6abb179))
* **recipe-check:** export the typed judge spec model ([#120](https://github.com/introspection-org/pi-recipes/issues/120)) ([49bf99d](https://github.com/introspection-org/pi-recipes/commit/49bf99d7c92297bd512dc52fccac9de2acea3d01))

## [0.12.0](https://github.com/introspection-org/pi-recipes/compare/v0.11.0...v0.12.0) (2026-07-21)


### Features

* **recipe-check:** validate portable direct-child recipe judge YAML through every checker surface ([#117](https://github.com/introspection-org/pi-recipes/issues/117)) ([32ecf79](https://github.com/introspection-org/pi-recipes/commit/32ecf79a808dec375c2c961f09ebf6615eeb2835))


### Bug Fixes

* **recipe-check:** accept IPv6 loopback URLs in judge local model configuration ([#117](https://github.com/introspection-org/pi-recipes/issues/117)) ([32ecf79](https://github.com/introspection-org/pi-recipes/commit/32ecf79a808dec375c2c961f09ebf6615eeb2835))
* isolate release train state ([#119](https://github.com/introspection-org/pi-recipes/issues/119)) ([c4700e9](https://github.com/introspection-org/pi-recipes/commit/c4700e97ac35130208b4fe6baae2e550eefad645))
* **release:** repair and separate release trains ([#115](https://github.com/introspection-org/pi-recipes/issues/115)) ([b49e0c5](https://github.com/introspection-org/pi-recipes/commit/b49e0c5ce9f16bae325e01636487c64aa118c011))

## [0.11.0](https://github.com/introspection-org/pi-recipes/compare/v0.10.4...v0.11.0) (2026-07-21)


### Features

* **python:** add pi-recipe-check bindings ([#100](https://github.com/introspection-org/pi-recipes/issues/100)) ([37fc176](https://github.com/introspection-org/pi-recipes/commit/37fc176a198fcf96823b2b110a1e8ee106576d97))


### Bug Fixes

* **agent:** enqueue child completion before persisting to close poke race ([#106](https://github.com/introspection-org/pi-recipes/issues/106)) ([592ed89](https://github.com/introspection-org/pi-recipes/commit/592ed89603c145775f7e8bff10e8119cb14f81ef))
* **release:** make root own platform package versions ([#114](https://github.com/introspection-org/pi-recipes/issues/114)) ([bf29058](https://github.com/introspection-org/pi-recipes/commit/bf2905825f3ad0f6aa9dffe8287a479c968c4687))
* **release:** use manifest grouping for checker libraries ([#105](https://github.com/introspection-org/pi-recipes/issues/105)) ([21e553c](https://github.com/introspection-org/pi-recipes/commit/21e553c8cb75b0c21c790c092a443f1e29d12010))
* unify recipe-check release versions ([#112](https://github.com/introspection-org/pi-recipes/issues/112)) ([25badb6](https://github.com/introspection-org/pi-recipes/commit/25badb6339c5141e965f982979874f2a15f47e30))


### Performance Improvements

* ship recipe-check as per-platform optional dependencies ([#110](https://github.com/introspection-org/pi-recipes/issues/110)) ([3c7ad24](https://github.com/introspection-org/pi-recipes/commit/3c7ad2402517d4cd31694d08bc1b505f63652355))

## [0.10.4](https://github.com/introspection-org/pi-recipes/compare/v0.10.3...v0.10.4) (2026-07-16)


### Bug Fixes

* relax recipe check diagnostics ([#96](https://github.com/introspection-org/pi-recipes/issues/96)) ([7509157](https://github.com/introspection-org/pi-recipes/commit/75091574272f91270e678af25a0221e9ce2a605e))

## [0.10.3](https://github.com/introspection-org/pi-recipes/compare/v0.10.2...v0.10.3) (2026-07-16)


### Bug Fixes

* require native MCP daemon client ([#94](https://github.com/introspection-org/pi-recipes/issues/94)) ([8b0ec4b](https://github.com/introspection-org/pi-recipes/commit/8b0ec4bb0dcf1ce9dd7f73db4f20d83e61cb35f4))

## [0.10.2](https://github.com/introspection-org/pi-recipes/compare/v0.10.1...v0.10.2) (2026-07-16)


### Bug Fixes

* accelerate MCP daemon bootstrap ([#92](https://github.com/introspection-org/pi-recipes/issues/92)) ([b862604](https://github.com/introspection-org/pi-recipes/commit/b8626044e4b73a862f21183f49a660751c978d29))
* agent skill and subagent omission semantics ([#86](https://github.com/introspection-org/pi-recipes/issues/86)) ([fea3bf6](https://github.com/introspection-org/pi-recipes/commit/fea3bf625a83f375a1c5854d4a5b556512f48b7a))
* preserve MCP CLI entrypoint ([#93](https://github.com/introspection-org/pi-recipes/issues/93)) ([f9c48f3](https://github.com/introspection-org/pi-recipes/commit/f9c48f3b00ea524a54ef7da5fc2991e337b885ef))

## [0.10.1](https://github.com/introspection-org/pi-recipes/compare/v0.10.0...v0.10.1) (2026-07-15)


### Bug Fixes

* coordinate MCP catalog preload in daemon ([#88](https://github.com/introspection-org/pi-recipes/issues/88)) ([258a72a](https://github.com/introspection-org/pi-recipes/commit/258a72af28ed6fa5ee5da08768effc281589f0c8))

## [0.10.0](https://github.com/introspection-org/pi-recipes/compare/v0.9.7...v0.10.0) (2026-07-15)


### Features

* share resolved recipes and the background agent tool ([#80](https://github.com/introspection-org/pi-recipes/issues/80)) ([65edc26](https://github.com/introspection-org/pi-recipes/commit/65edc262a3557b42c461e17317c9ee94cd8eb7e9))

## [0.9.7](https://github.com/introspection-org/pi-recipes/compare/v0.9.6...v0.9.7) (2026-07-15)


### Bug Fixes

* export MCP catalog preloading ([#83](https://github.com/introspection-org/pi-recipes/issues/83)) ([cbfe168](https://github.com/introspection-org/pi-recipes/commit/cbfe1681e4637005e27e54e2e293c4fda66a5121))

## [0.9.6](https://github.com/introspection-org/pi-recipes/compare/v0.9.5...v0.9.6) (2026-07-15)


### Bug Fixes

* warm MCP catalogs asynchronously ([#81](https://github.com/introspection-org/pi-recipes/issues/81)) ([b21a500](https://github.com/introspection-org/pi-recipes/commit/b21a50067e448f514ab39f95b83e6b1be6ac6881))

## [0.9.5](https://github.com/introspection-org/pi-recipes/compare/v0.9.4...v0.9.5) (2026-07-15)


### Bug Fixes

* resolve bundled MCP native client ([#78](https://github.com/introspection-org/pi-recipes/issues/78)) ([0212964](https://github.com/introspection-org/pi-recipes/commit/0212964c7d9ee9d7fcc9595bad0dda9b3d70a428))

## [0.9.4](https://github.com/introspection-org/pi-recipes/compare/v0.9.3...v0.9.4) (2026-07-15)


### Bug Fixes

* reduce MCP client process overhead ([#76](https://github.com/introspection-org/pi-recipes/issues/76)) ([0633059](https://github.com/introspection-org/pi-recipes/commit/063305921d8e307dc49012a40b2b834c4eb45ad7))

## [0.9.3](https://github.com/introspection-org/pi-recipes/compare/v0.9.2...v0.9.3) (2026-07-14)


### Bug Fixes

* resolve recipe extension package aliases ([#74](https://github.com/introspection-org/pi-recipes/issues/74)) ([c3c1caa](https://github.com/introspection-org/pi-recipes/commit/c3c1caa60997c1dd9f47f04a209aca4860db6703))

## [0.9.2](https://github.com/introspection-org/pi-recipes/compare/v0.9.1...v0.9.2) (2026-07-14)


### Bug Fixes

* persist MCP runtime across commands ([18600f1](https://github.com/introspection-org/pi-recipes/commit/18600f1fc0705f5ad9614af4e1a1f8629ad3a319))

## [0.9.1](https://github.com/introspection-org/pi-recipes/compare/v0.9.0...v0.9.1) (2026-07-14)


### Bug Fixes

* avoid nested MCP CLI processes ([#65](https://github.com/introspection-org/pi-recipes/issues/65)) ([f2848e7](https://github.com/introspection-org/pi-recipes/commit/f2848e7ea1b29b8155a10cc5627bdcc8fc473705))
* separate package release pull requests ([#66](https://github.com/introspection-org/pi-recipes/issues/66)) ([dbbd048](https://github.com/introspection-org/pi-recipes/commit/dbbd048d024fb71a168085de8e4c905434ec6da2))

## [0.9.0](https://github.com/introspection-org/pi-recipes/compare/v0.8.0...v0.9.0) (2026-07-13)


### Features

* lazily discover MCP tools per session ([#63](https://github.com/introspection-org/pi-recipes/issues/63)) ([f8fedf0](https://github.com/introspection-org/pi-recipes/commit/f8fedf0a466ffa25ab22c96bc22b82a48a2e562d))

## [0.8.0](https://github.com/introspection-org/pi-recipes/compare/v0.7.1...v0.8.0) (2026-07-12)


### Features

* **recipe-check:** storage in the resources grammar + deployment-configuration spec ([#59](https://github.com/introspection-org/pi-recipes/issues/59)) ([a5623b9](https://github.com/introspection-org/pi-recipes/commit/a5623b99aea36537a309d99cc87949e5a0878333))

## [0.7.1](https://github.com/introspection-org/pi-recipes/compare/v0.7.0...v0.7.1) (2026-07-12)


### Bug Fixes

* **pi-recipe-check:** add pure resources validation module ([#56](https://github.com/introspection-org/pi-recipes/issues/56)) ([c3a78cd](https://github.com/introspection-org/pi-recipes/commit/c3a78cdfdd880d3aca672bb28b98937a3d532dc9))

## [0.7.0](https://github.com/introspection-org/pi-recipes/compare/v0.6.4...v0.7.0) (2026-07-12)


### Features

* **pi-recipe-check:** extract pure validation core and prepare crates.io publishing ([#54](https://github.com/introspection-org/pi-recipes/issues/54)) ([d5147c0](https://github.com/introspection-org/pi-recipes/commit/d5147c05c59907de783e5cb7e86a78287fab546a))

## [0.6.4](https://github.com/introspection-org/pi-recipes/compare/v0.6.3...v0.6.4) (2026-07-12)


### Bug Fixes

* make MCP metadata and invocation token-efficient ([7b3136c](https://github.com/introspection-org/pi-recipes/commit/7b3136cc0415c0c6c9f43d4982e75c04f411978d))
* mark MCP CLI network calls for trace baggage ([1486454](https://github.com/introspection-org/pi-recipes/commit/148645458706d6746fc25ce996dfcc892d717556))

## [0.6.3](https://github.com/introspection-org/pi-recipes/compare/v0.6.2...v0.6.3) (2026-07-11)


### Bug Fixes

* Remove implicit system prompt additions ([#48](https://github.com/introspection-org/pi-recipes/issues/48)) ([9bf3b4b](https://github.com/introspection-org/pi-recipes/commit/9bf3b4b87f39ab03fd3afa3af06a16b1bf768e00))

## [0.6.2](https://github.com/introspection-org/pi-recipes/compare/v0.6.1...v0.6.2) (2026-07-11)


### Bug Fixes

* include MCP CLI help in npm package ([#45](https://github.com/introspection-org/pi-recipes/issues/45)) ([952a2ab](https://github.com/introspection-org/pi-recipes/commit/952a2abb10fc6318a435764568ffdece1b6828b7))

## [0.6.1](https://github.com/introspection-org/pi-recipes/compare/v0.6.0...v0.6.1) (2026-07-10)


### Bug Fixes

* add a capability-scoped MCP CLI for recipe agents ([#44](https://github.com/introspection-org/pi-recipes/issues/44)) ([c48a519](https://github.com/introspection-org/pi-recipes/commit/c48a5198558eaf377f7ce6310a51b4e6cc0f55a8))

## [0.6.0](https://github.com/introspection-org/pi-recipes/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* add explicit per-server MCP tool selection ([#40](https://github.com/introspection-org/pi-recipes/issues/40)) ([8a1ee0f](https://github.com/introspection-org/pi-recipes/commit/8a1ee0f96facc56308771b1315dd24c5e2cc0902))
* improve MCP capability disclosure ([7bc380c](https://github.com/introspection-org/pi-recipes/commit/7bc380c474c83b802cb2821983701686de95aa8f))


### Bug Fixes

* enforce recipe agent tool allowlists ([7d86939](https://github.com/introspection-org/pi-recipes/commit/7d8693925a3523022e9c7aef76c0ee250f34494b))
* warn when MCP agents omit bash ([75b5586](https://github.com/introspection-org/pi-recipes/commit/75b5586c40d60e64ca1db34fd32cd5b596aee13b))

## [0.5.0](https://github.com/introspection-org/pi-recipes/compare/v0.4.1...v0.5.0) (2026-07-09)


### Features

* recipe agent model config (stream options, provider routing) ([1f0afc8](https://github.com/introspection-org/pi-recipes/commit/1f0afc83fab2af303c295b8abbc9ff3dd7a1cdd4))
* shared mcp CLI prompt section and skillsDeclared flag ([7fe5a08](https://github.com/introspection-org/pi-recipes/commit/7fe5a085c5f322d63015884f5ef8ea91d4cb622c))


### Bug Fixes

* build CLI artifacts before tests ([a22e748](https://github.com/introspection-org/pi-recipes/commit/a22e7485ba1848b2bb5bce9d46569c7dfa8ecfe4))
* detect symlinked mcp CLI entry so pnpm and bin-shim launches run ([67e69d1](https://github.com/introspection-org/pi-recipes/commit/67e69d1d7dcb77389f4a29485f0cbdd38245e035))
* name bootstrap MCP servers from serverInfo and the endpoint label ([52b60ac](https://github.com/introspection-org/pi-recipes/commit/52b60accdc5cf32159ca91aa6e3ba311eb25059e))
* validate agent MCP refs against recipe policy ([ed20943](https://github.com/introspection-org/pi-recipes/commit/ed209431163fac21cc7ec16b20b87e0d3285a05c))

## [0.4.1](https://github.com/introspection-org/pi-recipes/compare/v0.4.0...v0.4.1) (2026-07-09)


### Bug Fixes

* pack child-agent-completions and guard packed module imports ([#31](https://github.com/introspection-org/pi-recipes/issues/31)) ([3f1ee31](https://github.com/introspection-org/pi-recipes/commit/3f1ee311955dab0087d33bd841cd71f842b0fa76))

## [0.4.0](https://github.com/introspection-org/pi-recipes/compare/v0.3.0...v0.4.0) (2026-07-09)


### ⚠ BREAKING CHANGES

* the `mcp tools sources|search|describe` and JSON-args `mcp call` command surface is replaced by mcporter's CLI. The `main`, `callMcpTool`, `localMcpHeadersForServer`, and `mcpCliEntrypointPath` exports are removed (`mcporterCliEntrypointPath` replaces the latter). `dist/mcp.js` is no longer an executable entrypoint. mcporter declares engines node >=24; Node 24+ is recommended (0.12.3 verified working on Node 22).

### Features

* add mcp search and run helpers ([73a0edb](https://github.com/introspection-org/pi-recipes/commit/73a0edb269d56c6c00725d5cfb04c84e674c0c67))
* mcp run --var KEY=value for safe dynamic values in code mode ([7a5bfb4](https://github.com/introspection-org/pi-recipes/commit/7a5bfb40b3c7189eae7043713aefdba4e388e34f))
* replace the bundled mcp CLI with mcporter ([d512d4b](https://github.com/introspection-org/pi-recipes/commit/d512d4b48ed1b0c072cd84852eba7de136cd4f62))
* show tool output schemas in mcp list --schema ([fb3d151](https://github.com/introspection-org/pi-recipes/commit/fb3d151a4f19d671758ca67a25a23910c4c5bae8))
* trigger patch release ([731aeca](https://github.com/introspection-org/pi-recipes/commit/731aecab39c54d7197e942204d8bd52a45a82cea))


### Bug Fixes

* agent-friendly mcp CLI error paths ([81d476b](https://github.com/introspection-org/pi-recipes/commit/81d476b1ea49b4ec511bb1392b91ebc78ce136f1))
* brand delegated mcp cli output consistently ([1f93178](https://github.com/introspection-org/pi-recipes/commit/1f931788df6335bba3cfd3d39dd4b5356bba24a2))
* hide upstream mcp cli version banner ([b5b697a](https://github.com/introspection-org/pi-recipes/commit/b5b697ade53ec7a7a0735e1b25bb43cb642603b7))
* hint at bearer-token expiry behind OAuth metadata errors ([d2c7f1c](https://github.com/introspection-org/pi-recipes/commit/d2c7f1c28d818563eab3717bb36ad16dddcd71db))
* report invalid mcp search regex ([dc10369](https://github.com/introspection-org/pi-recipes/commit/dc10369cc701bf537f00c24f3a0587a20f6e4933))


### Miscellaneous Chores

* release 0.4.0 ([2289154](https://github.com/introspection-org/pi-recipes/commit/2289154656e672df51e1aa691692b0c025fc58a9))

## [0.3.0](https://github.com/introspection-org/pi-recipes/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* release recipe interaction helpers ([5937e8a](https://github.com/introspection-org/pi-recipes/commit/5937e8a3ee9fe4d2442254253467ddec7775dde1))

## [0.2.0](https://github.com/introspection-org/pi-recipes/compare/v0.1.0...v0.2.0) (2026-07-08)


### Features

* add Harbor recipe evals ([9b742c3](https://github.com/introspection-org/pi-recipes/commit/9b742c39595610677c1814ec1f69fe032b9e1c96))
* add recipe check validator ([af8a76c](https://github.com/introspection-org/pi-recipes/commit/af8a76c74947f7c4f6d964ed737552d34a2daaec))
* simplify recipe telemetry contract ([6d6154c](https://github.com/introspection-org/pi-recipes/commit/6d6154c3ffb1aa7926669d3d0f7a4b028f6f8f7a))
* validate recipe model spec format and migrate to pi-ai compat entrypoint ([#18](https://github.com/introspection-org/pi-recipes/issues/18)) ([d129aca](https://github.com/introspection-org/pi-recipes/commit/d129aca97cc5f40df9b4870d9726a74e312855b8))


### Bug Fixes

* install Harbor eval recipes from writable copy ([0af06a3](https://github.com/introspection-org/pi-recipes/commit/0af06a38dddc25b772fda5c19ca312ec41793e6f))

## [0.1.0](https://github.com/introspection-org/pi-recipes/compare/v0.1.0-beta.2...v0.1.0) (2026-06-30)


### Bug Fixes

* count install telemetry once per recipe ([fe92eaf](https://github.com/introspection-org/pi-recipes/commit/fe92eaf848c010da5c50f96a8a29658aedb68a82))


### Miscellaneous Chores

* release 0.1.0 ([c7a2774](https://github.com/introspection-org/pi-recipes/commit/c7a2774fa4766ab81ef626534444effc2838276a))

## [0.1.0-beta.2](https://github.com/introspection-org/pi-recipes/compare/v0.1.0-beta.1...v0.1.0-beta.2) (2026-06-28)


### Features

* add session-scoped MCP support ([2bb532a](https://github.com/introspection-org/pi-recipes/commit/2bb532a309bff3f96180921e3caab9474ddb4ec6))


### Bug Fixes

* keep recipe MCP manifests scoped to exposed tools ([2d0ca2c](https://github.com/introspection-org/pi-recipes/commit/2d0ca2c91cd857e08336b54dbce22ff772a6a917))

## [0.1.0-beta.1](https://github.com/introspection-org/pi-recipes/compare/v0.1.0-beta.0...v0.1.0-beta.1) (2026-06-27)


### ⚠ BREAKING CHANGES

* recipe manifests no longer support theme resources, and the Pi extension no longer exposes recipe themePaths.

### Features

* remove recipe theme resources ([#8](https://github.com/introspection-org/pi-recipes/issues/8)) ([032cd3b](https://github.com/introspection-org/pi-recipes/commit/032cd3bb6d0f5d0272af99de73f1e29ed31f707e))
* send anonymous install telemetry to the recipe directory ([8095c55](https://github.com/introspection-org/pi-recipes/commit/8095c5524e3333be35a4172d206cd345de101bdc))
* submit public recipe publishes to catalog ([09a6f0c](https://github.com/introspection-org/pi-recipes/commit/09a6f0cd6461da629dc776c9b877d06fc2470ad0))


### Bug Fixes

* allow blank agent system instructions ([#4](https://github.com/introspection-org/pi-recipes/issues/4)) ([dc50037](https://github.com/introspection-org/pi-recipes/commit/dc50037c509601748cbc8404c6c472f9eb5f507b))
* drop themes from publish catalog resource counts ([6f12cfa](https://github.com/introspection-org/pi-recipes/commit/6f12cfa6b507dd29a6f50bcaf9587732fb7f2d08))


### Miscellaneous Chores

* force next beta release ([1a3be58](https://github.com/introspection-org/pi-recipes/commit/1a3be58fce15b43d23508a1b61cbc6e4ba1df754))

## 0.1.0-beta.0 (2026-06-25)


### Features

* prepare pi recipes beta release ([4eed1cd](https://github.com/introspection-org/pi-recipes/commit/4eed1cdfd9c32c816306ce041c457701b81c76e3))
