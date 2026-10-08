/** M4 run identity (docs/evaluations/ptc/ptc-m4-evaluation.md); pins are part of the controller source hash. */

/** The accepted M1 baseline: pinned last chain run and aggregate reports. */
export const M4_BASELINE = {
  lastRun: 'openai-005',
  report: '38853795d1b446498a7cec9240d992c1d8e8905ca8f8c2a6044c9923937b6a19',
  plansReport: 'a720dc590edef4822c273b266a5d950f5bceb15122aacb7066fc64569403e21d',
  carry: { spentUnits: 107003327, admittedAttempts: 2153 },
} as const;

/** Completed M4 runs, in order: their artifacts, binaries and where the budget ended. */
export const M4_COMPLETED = [
  {
    name: 'ptc-m4-001',
    marker: '.ptc-m4-openai-attempted',
    pins: {
      node: '6b29696fbfebaa9d29140559ea7adf7f1d2d08100b51704aaa8e646270ea59c9',
      chat: '27db918b9fc747113c0c17cb64323c6ad6e1063b8f209b64eb9300503beae598',
    },
    trials: '3dbcfb63088b28a18c2206f4931c5c134a992d2a0534f3e81862595e6bc2fe0c',
    budget: 'd7ef882c09076a7efe921480e163a03131d6480527588a8b841c509d6b31e908',
    summary: 'db112e3a90191e17c9c5bc7071a49ff0953529cd0782af894cf1dfd2fba1d59d',
    /** Remote report and its Prettier-formatted copy in docs/evaluations/ptc/. */
    report: '387280ad0e085f00277839ed7a1234151ad093b6ea6a98284d790f5aa3c6d995',
    plansReport: '6ae97e8d81bd1adf0cfb541c5c9a623947d6c548fcd60c6ec4ed4189043f74c8',
    carry: { spentUnits: 173299750, admittedAttempts: 4294 },
  },
] as const;

/**
 * Round 2 run `ptc-m4-002` (core capability signatures in the system prompt) stopped at row 310
 * of 450 on an uncertain-usage attempt. It is continued, not restarted (round 2 amendment).
 */
export const M4_STOPPED = {
  name: 'ptc-m4-002',
  marker: '.ptc-m4-002-openai-attempted',
  pins: {
    node: 'daf6b7a49552e9e8a77a426ab657f751bab346e5ad8959bbbf04640b7014bbed',
    chat: 'd214cc1cfe9b5133e31e000822042d0ea029d9c782cd72572755205515c35c9c',
  },
  controller: '898ec6c16d23244e90e20759f0ffafc93aedc95b17c7e165568507d5a5939645',
  trials: 'c55448b80d1139c44e0e16fb89a691c06f50c700de52ddd388f9a3fd815dbbeb',
  budget: 'cce881512f754095216c4e623c0a9e60ad21151b34811b7a9232ac33c2214eb0',
  summary: 'cae9acdd66fd15b58496a98cc94d4783f5aabccbacdba898cf2e9cf4f03bf079',
  carry: M4_COMPLETED.at(-1)!.carry,
} as const;

/** The run this tree executes: the continuation of the stopped run, on the same binaries. */
export const M4_RUN = 'ptc-m4-003';
export const M4_MARKER = '.ptc-m4-003-openai-attempted';
export const M4_PINS = M4_STOPPED.pins;

/** Round 2's continuation, completed (the stopped run plus this make one matrix). */
export const M4_ROUND2_END = {
  name: 'ptc-m4-003',
  marker: '.ptc-m4-003-openai-attempted',
  trials: '4f4ef1daea54d837b14a5bad5f01e83e14281412643223d61a2040c666a89224',
  budget: '4d5b5803429d4e14482ca83b2029a317b73d6bdc5b81b8045d930879b24bb8d9',
  summary: 'a4435c1f4b953066bce15875ea99c4eb30ee86a4ba293f330ad06d255ae020d6',
  report: '5d23abfb84ba6bda7d6b1713608dfbb864fb1d072347882d9939885ec5fa26bf',
  plansReport: 'ca5410769a5a3ffdfc7f5a64f2863e8ffc62b0731c8ff93160efc841f038fcbd',
  carry: { spentUnits: 292259993, admittedAttempts: 6169 },
} as const;

/**
 * Round 3 (docs/evaluations/ptc/ptc-m4-evaluation.md): the hybrid surface, measured interleaved with the
 * pinned M1 `main` binaries in the same session. Branch pins are set from the deployed builds.
 */
export const M4_R3 = {
  arms: {
    main: {
      node: '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80',
      chat: 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf',
    },
    ptc: {
      node: 'b461ffc8399b143aa4c2add015c3c1684198a91d89f737a2c5b4e1656ca575b1',
      chat: '527b101c628e8b93661dca230a70b8d6175038e5a62f0221654920f81f74f6bb',
    },
  },
  carry: M4_ROUND2_END.carry,
} as const;

/** Every M4 artifact that may exist before a round 3 run (names only). */
export const M4_PINNED_FILES: readonly string[] = [
  ...[...M4_COMPLETED, M4_STOPPED, M4_ROUND2_END].flatMap((run) => [
    `${run.name}.trials.jsonl`,
    `${run.name}.budget.jsonl`,
    `${run.name}.summary.json`,
    `${run.name}-report.json`,
    `${run.name}.stage.pending.json`,
    `${run.name}.stage.approve.json`,
    `${run.name}.stage.accepted.json`,
    run.marker,
  ]),
];

/**
 * Stopped round 3 runs, in order, each continued by the next (round 2 amendment rule,
 * pre-declared for round 3). Empty until a run stops; pins are added before continuing.
 */
export const M4_R3_STOPS: ReadonlyArray<{
  name: string;
  trials: string;
  budget: string;
  summary: string;
  controller: string;
  carry: { spentUnits: number; admittedAttempts: number };
}> = [
  {
    // Stopped at row 562 of 900 (main / team-wait / uncached / 3): an auxiliary request was
    // cancelled mid-stream without usage; its reservation was kept and the budget halted.
    name: 'ptc-m4-r3-001',
    trials: 'cf6ce8d5bac9ddf5a469a6612f394b63c68f0b007eae624df457e46368650c5d',
    budget: 'fc0a8b4b45d2c061c9b9f7cba07c86ea57fa798e477605e6c4e93ae9b30acf6e',
    summary: '3e5a43db7353b8b20dc4aebc348b65a8bd99fcb5ca3b7d9de21c0d7381dc370a',
    controller: 'aebee09f21e8614e54dd15341af7a4e655e795b8fd44a1988e013a7e7c92c52b',
    carry: { spentUnits: 292259993, admittedAttempts: 6169 },
  },
  {
    // Stopped on its second row (main / team-wait / prime / 3), the same way.
    name: 'ptc-m4-r3-002',
    trials: '7c73e3cbae7f588c89d90e363c36a31a3a39be0ecfaa97d486d0dd05c6793ffd',
    budget: '1d0694d1c3f1e98c15143a87e7d25c06bfb191a562445eca1d593de744a79eb4',
    summary: 'f4a730735eedad390f1f52ff9d588e3613c1ee31b092644f20a7f21306a488b7',
    controller: '46cbda350f73a8b3637d4f8bb848e2b895622cc53067fa415ae22a19dee3e77d',
    carry: { spentUnits: 439080757, admittedAttempts: 8482 },
  },
  {
    // Stopped on main / team-wait / warm / 3, the same way; the relay now reads such
    // responses to the end for their usage (round 3 amendment).
    name: 'ptc-m4-r3-003',
    trials: 'bf9bad7672a14750dbe97771300a0da53511ecd3cf3767ea4209a767af7477ea',
    budget: '6cb87dd8bf71fcc16b7db2510c2b9fe3a561a199b5086d9e70e08cd44f095925',
    summary: '6ad7fc719275fb3fb69909a8b43b0c79c750e10a9e69b06ffe886024a4d886a8',
    controller: '040b37f79eea9ef1eb0b22cad174e9457c52399079a75a2aa3c7a9f2026417d9',
    carry: { spentUnits: 488947199, admittedAttempts: 8501 },
  },
  {
    // Stopped on main / team-wait / uncached / 4: an abandoned auxiliary response ended without
    // usage even when read to its end. Round 3 ends here (partial; maintainer decision).
    name: 'ptc-m4-r3-004',
    trials: '3becb979624ba1c7ae860e317682f352ce6af56b92fe2c4c6c204ba97c0f702f',
    budget: 'bde3f5444a1e508f7cd5308475103105b6f4cee107b3d99d307e5c218cc87928',
    summary: '901192ce8b6fa7332d397a3e3e2a0a4d13ece3a18482392a72d0b40bc8f21d68',
    controller: '28824b6b58e072327f5146060b7f371751245a3155ef80f0a2cd980634b93069',
    carry: { spentUnits: 537981381, admittedAttempts: 8519 },
  },
];
/** Round 3 run names: ptc-m4-r3-001, then one more per stop. */
export const m4R3Run = (n: number) => `ptc-m4-r3-${String(n).padStart(3, '0')}`;
export const m4R3Marker = (n: number) => `.${m4R3Run(n)}-attempted`;

/** Round 3 ended partially (maintainer decision): its validated chain ends at this budget. */
export const M4_ROUND3_END = {
  partialReport: '22cf7d559e07eeb5afabf0bffb1c905cba29065b9c8fa9b676282d54843c4ce0',
  plansReport: 'b1fd100b53eabc9a8adb24d912232892c3183a506cb14bd567e10baba4c509bc',
  carry: { spentUnits: 587296559, admittedAttempts: 8545 },
} as const;

/**
 * Round 4 (docs/evaluations/ptc/ptc-m4-evaluation.md, final round): Pi-codemode-informed changes on the hybrid
 * surface, measured interleaved with the same pinned `main` binaries. Branch pins are set from
 * the deployed builds before the run.
 */
export const M4_R4 = {
  arms: {
    main: M4_R3.arms.main,
    ptc: {
      node: 'e9408bbb91b67634d68ec7760f7698eaa30fc0b894ba7b6efd1ffdc32d124bd8',
      chat: 'b54be5b0be56edfd385915e5c010de92fc3f07a54d0eb7be676f57233b75e7a5',
    },
  },
  carry: M4_ROUND3_END.carry,
  /** The independent budget's limit, raised from USD 100 by maintainer decision 2026-10-07. */
  limitUsd: 150,
  /** Session titles off for both arms: not part of any fixture, and the round 3 stop cause. */
  features: { sessionTitle: { enabled: false } },
} as const;
/** Stopped round 4 runs, continued under the round 2 amendment rule (pinned before continuing). */
export const M4_R4_STOPS: ReadonlyArray<{
  name: string;
  trials: string;
  budget: string;
  summary: string;
  controller: string;
  carry: { spentUnits: number; admittedAttempts: number };
}> = [];
export const m4R4Run = (n: number) => `ptc-m4-r4-${String(n).padStart(3, '0')}`;
export const m4R4Marker = (n: number) => `.${m4R4Run(n)}-attempted`;

/** Round 4 completed in one run; round 5 continues its budget. */
export const M4_ROUND4_END = {
  name: 'ptc-m4-r4-001',
  marker: '.ptc-m4-r4-001-attempted',
  trials: 'e2199118a08bfc7696ca8bcee7f080c3ca1637b932b76501c6ff2817942bd249',
  budget: 'b2af178765c33e8b97df042ebfcf13d1cad9e18f786bf9643d429dd9c0295bd5',
  summary: '8c4c7ca51cf44dc7e9520565e6380a1cbf93b2f1e867bafefa8d87bbf1c3f4c3',
  report: '7fce5b2e490014634253d3b6f16b783ecec8a8b4d3b567b87f51f3e00804d9bf',
  plansReport: '2fada3451255cfeb35b9a8154f378a7e2e66ec56600e2b08b51802bf226184a7',
  carry: { spentUnits: 763944992, admittedAttempts: 11232 },
} as const;

/**
 * Round 5 (docs/evaluations/ptc/ptc-m4-evaluation.md, final optimization): compact signatures for non-core
 * capabilities, a complete-list statement and stronger routing, measured as round 4 was.
 */
export const M4_R5 = {
  arms: {
    main: M4_R3.arms.main,
    ptc: {
      node: '17e92707009e5a133f78830c2e7f08999004ae60074777bdd923a2a7e4cddd03',
      chat: '7c71cd7036de6adcf75974de842f8845612afb1aafbb55daba3bd99ab2699d0b',
    },
  },
  carry: M4_ROUND4_END.carry,
  limitUsd: 150,
  features: { sessionTitle: { enabled: false } },
} as const;
export const M4_R5_STOPS: ReadonlyArray<{
  name: string;
  trials: string;
  budget: string;
  summary: string;
  controller: string;
  carry: { spentUnits: number; admittedAttempts: number };
}> = [
  {
    // Stopped on ptc / team-wait / uncached / 7: the helper was not the fixture's named one, so
    // five child requests had no attributable owner and the accounting gate stopped the run.
    // Every attempt had usage; nothing uncertain was charged.
    name: 'ptc-m4-r5-001',
    trials: 'cae45f3b4aaa76afa39d4d2e387e295d3fc04f906cf576920c246fa6833f1627',
    budget: '00ae44407a258c272206257a089efeba92bcaa7b31b8f212002e1fa75ce207fa',
    summary: '6fc4e34df60dab7f3d36558c4bfacd3ee3bff7811a7f165ab171dad7a4f9bc04',
    controller: '15f82e9bfdffc1edbeb6e7e1fd2896b5b65ad045e4a4c9757716056f93ef82d8',
    carry: { spentUnits: 763944992, admittedAttempts: 11232 },
  },
  {
    // Stopped on ptc / team-wait / uncached / 9: the parent's first model response ended
    // without usage (the client stopped reading, the relay read on; no usage arrived), so its
    // reservation was charged and the budget halted.
    name: 'ptc-m4-r5-002',
    trials: '80548b9ad4034e2c5b825030c3780dd160daf0031a1e39d884a7684b9e4f9079',
    budget: 'e6c7fbae8c199cc26f4d2b8eb3c8ebef6057237b35461d815611e79e7b4033f6',
    summary: 'b1130c09731377e70e97cc495b6739bafd43544bd848b586322ff0c8adad58f6',
    controller: '8b275b08c5b969e2662471644f547b1f27fad2d1b6a076d0ffcfdbacfa0a5f3f',
    carry: { spentUnits: 874730612, admittedAttempts: 13092 },
  },
];
export const m4R5Run = (n: number) => `ptc-m4-r5-${String(n).padStart(3, '0')}`;
export const m4R5Marker = (n: number) => `.${m4R5Run(n)}-attempted`;

/** Round 5 ended with its third run; the public-benchmark runs continue its budget. */
export const M4_ROUND5_END = {
  name: 'ptc-m4-r5-003',
  marker: '.ptc-m4-r5-003-attempted',
  trials: '88d8b4e586b9ed71a522d62da45c4f55625d0b9b9c15ea32064662c25bb1c3c8',
  budget: 'e9b92984bafdc11611b1f8b242690bbb5dce2ba26d0db5e38b9c3f6b760aad2e',
  summary: '7c59ff1c425e0405c107591ec1b52ceeeecd3479c1a27a9f45e19d4a7023a6db',
  report: 'f25acfedabc0a5d6028ed445cc9b16fbd30acbf1e962897ab901b3cb71a0f66f',
  plansReport: '110a81bd9570f880b766f60fab36179c0a423183972cc43d59d05a935936829c',
  carry: { spentUnits: 966430967, admittedAttempts: 13770 },
} as const;

/**
 * Public-benchmark runs (docs/evaluations/ptc/ptc-m4-evaluation.md, "Public benchmark"), in order. Each ends
 * where the next one's budget starts (an uncertain reservation left at a stop counts as spent).
 */
export const M4_POLY_RUNS: ReadonlyArray<{
  name: string;
  mode: 'dev' | 'holdout';
  /** The run completed cleanly (a holdout may be rerun only after an incomplete one). */
  complete: boolean;
  trials: string;
  budget: string;
  summary: string;
}> = [
  {
    // Development run 1: the round 5 hybrid build, unchanged (the tuning baseline).
    name: 'ptc-m4-poly-001',
    mode: 'dev',
    complete: true,
    trials: '6ac104cd1fe40b64b8e9e408c964a765a48fc6585564df7b8567079b35d5688b',
    budget: 'ed27ac910717cc4cdd7f03c9140f04e8df86acc0011e4cd32c2e885dff09bd85',
    summary: '69a8693c199aa8105074d413186eca76fe5536e2c29fdd6e8f897b942240441e',
  },
  {
    // Development run 2: edit-then-check sequences routed into one script.
    name: 'ptc-m4-poly-002',
    mode: 'dev',
    complete: true,
    trials: '16f27ad3c0985f201caeb7ca02bfe53a563263852fc06a49e459bc5d0612cc91',
    budget: 'afecb153f1f09b592ac8d8c702b5752a83645f8dd3f728c4f46adfd9e30463fd',
    summary: '749703c2f22d04694975cebd2a38da6823e06f9bd6e1e7d7ac46812c20aeec5e',
  },
  {
    // The holdout run: complete, judged.
    name: 'ptc-m4-poly-003',
    mode: 'holdout',
    complete: true,
    trials: '15556e4ae1e12613436e3cb53b37261faa7e4e0581a4aaf8ddc4554d32092274',
    budget: '201aac8702c785d8d7b8b5df5a1a7aaa872e6e6fc8970b222fd09b47e0c39612',
    summary: '88ba56d0e56ca48e9da4629fa14461372da6807ddc97b97d9f364639667a5373',
  },
];

/** Every M4 file name that may exist before a public-benchmark run, and the markers required. */
export function m4KnownFiles(): { allowed: Set<string>; markers: string[] } {
  const runFiles = (name: string, marker: string) => [
    `${name}.trials.jsonl`,
    `${name}.budget.jsonl`,
    `${name}.summary.json`,
    `${name}-report.json`,
    `${name}.stage.pending.json`,
    `${name}.stage.approve.json`,
    `${name}.stage.accepted.json`,
    marker,
  ];
  const marker = (name: string) => `.${name}-attempted`;
  const runs = [
    ...M4_R3_STOPS.map((run) => run.name),
    M4_ROUND4_END.name,
    ...M4_R5_STOPS.map((run) => run.name),
    M4_ROUND5_END.name,
    ...M4_POLY_RUNS.map((run) => run.name),
  ];
  return {
    allowed: new Set([
      ...M4_PINNED_FILES,
      'ptc-m4-r3-partial-report.json',
      ...runs.flatMap((name) => runFiles(name, marker(name))),
    ]),
    markers: [M4_ROUND2_END.marker, ...runs.map(marker)],
  };
}
/** The holdout run's branch binaries (set before the holdout run, after tuning). */
export const M4_POLY_HOLDOUT = {
  arms: {
    main: M4_R3.arms.main,
    // The development run 2 build (tuning ended there).
    ptc: {
      node: 'fe093f1c0fefadb3a236713b8d06c0a279de08f1f8064abcaa7d59b6285cbf9a',
      chat: '065ce3e2123ffb1a9568541e8695fcc0559a9873f29f9fa1b2c99cd815435dec',
    },
  },
  trials: 2,
} as const;
export const M4_POLY = {
  limitUsd: 150,
  features: { sessionTitle: { enabled: false } },
  trialDeadlineMs: 900_000,
} as const;
