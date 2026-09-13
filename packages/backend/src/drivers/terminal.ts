// A terminal manager wrapping node-pty: multi-instance, session-scoped, with a
// bounded per-instance scrollback so late-attaching renderers can replay output.

import { createRequire } from "node:module";

export type PtyHandle = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
};

export type SpawnPty = (input: {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}) => PtyHandle;

export type TerminalInstanceInfo = {
  terminalId: string;
  sessionId: string;
  cwd: string;
  status: "running" | "exited";
  exitCode?: number;
};

export type TerminalManagerEvent =
  | {
      kind: "output";
      terminalId: string;
      sessionId: string;
      piSessionId: string;
      data: string;
      /** Cumulative stream length (UTF-16 code units) after this chunk. */
      end: number;
    }
  | {
      kind: "exit";
      terminalId: string;
      sessionId: string;
      piSessionId: string;
      exitCode: number;
    };

export type TerminalManager = {
  create(input: {
    sessionId: string;
    piSessionId: string;
    cwd: string;
    cols: number;
    rows: number;
  }): Promise<TerminalInstanceInfo>;
  list(sessionId: string): TerminalInstanceInfo[];
  attach(terminalId: string): { scrollback: string; end: number };
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  onEvent(listener: (event: TerminalManagerEvent) => void): () => void;
  disposeAll(): void;
};

export type TerminalManagerOptions = {
  spawnPty?: SpawnPty;
  scrollbackLimit?: number;
  now?: () => string;
};

// Minimal structural view of the @lydell/node-pty process handle.
type NodePtyProcess = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
};

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): NodePtyProcess;
};

type TerminalRecord = {
  terminalId: string;
  sessionId: string;
  piSessionId: string;
  cwd: string;
  status: "running" | "exited";
  exitCode?: number;
  scrollback: string;
  /** Total bytes ever emitted, ignoring scrollback trimming. */
  streamEnd: number;
  pty: PtyHandle;
};

const DEFAULT_SCROLLBACK_LIMIT = 256 * 1024;

export function createTerminalManager(
  options: TerminalManagerOptions = {},
): TerminalManager {
  const scrollbackLimit = options.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
  const terminals = new Map<string, TerminalRecord>();
  const listeners = new Set<(event: TerminalManagerEvent) => void>();
  let spawnPty = options.spawnPty;

  const emit = (event: TerminalManagerEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const info = (record: TerminalRecord): TerminalInstanceInfo => ({
    terminalId: record.terminalId,
    sessionId: record.sessionId,
    cwd: record.cwd,
    status: record.status,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
  });

  const requiredTerminal = (terminalId: string) => {
    const record = terminals.get(terminalId);

    if (!record) {
      throw new Error(`Terminal "${terminalId}" was not found.`);
    }

    return record;
  };

  const disposeAll = () => {
    for (const record of terminals.values()) {
      try {
        record.pty.kill();
      } catch {
        // Already dead.
      }
    }

    terminals.clear();
  };

  process.once("exit", disposeAll);

  return {
    async create(input) {
      if (!spawnPty) {
        // node-pty resolves its native files and spawn helper outside the archive.
        const requireFromDesktop = createRequire(import.meta.url);
        const nodePtySpecifier = "@lydell/node-pty";
        const nodePty = requireFromDesktop(nodePtySpecifier) as NodePtyModule;

        spawnPty = (spawnInput) => {
          const pty = nodePty.spawn(spawnInput.file, spawnInput.args, {
            name: "xterm-256color",
            cols: spawnInput.cols,
            rows: spawnInput.rows,
            cwd: spawnInput.cwd,
            env: spawnInput.env,
          });

          return {
            write: (data) => pty.write(data),
            resize: (cols, rows) => pty.resize(cols, rows),
            kill: () => pty.kill(),
            onData: (listener) => {
              pty.onData(listener);
            },
            onExit: (listener) => {
              pty.onExit(listener);
            },
          };
        };
      }

      const terminalId = `term-${crypto.randomUUID()}`;
      // node-pty decodes pty output to utf8 strings itself, so chunks pass
      // straight through to the scrollback and the output event.
      const record: TerminalRecord = {
        terminalId,
        sessionId: input.sessionId,
        piSessionId: input.piSessionId,
        cwd: input.cwd,
        status: "running",
        scrollback: "",
        streamEnd: 0,
        pty: spawnPty({
          file: process.env.SHELL ?? "/bin/zsh",
          args: ["-l"],
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          env: terminalEnvironment(),
        }),
      };

      terminals.set(terminalId, record);

      record.pty.onData((data) => {
        record.scrollback = appendBounded(record.scrollback, data, scrollbackLimit);
        record.streamEnd += data.length;
        emit({
          kind: "output",
          terminalId,
          sessionId: record.sessionId,
          piSessionId: record.piSessionId,
          data,
          end: record.streamEnd,
        });
      });
      record.pty.onExit(({ exitCode }) => {
        record.status = "exited";
        record.exitCode = exitCode;
        emit({
          kind: "exit",
          terminalId,
          sessionId: record.sessionId,
          piSessionId: record.piSessionId,
          exitCode,
        });
      });

      return info(record);
    },

    list(sessionId) {
      return [...terminals.values()]
        .filter((record) => record.sessionId === sessionId)
        .map(info);
    },

    attach(terminalId) {
      const record = terminals.get(terminalId);

      return { scrollback: record?.scrollback ?? "", end: record?.streamEnd ?? 0 };
    },

    write(terminalId, data) {
      requiredTerminal(terminalId).pty.write(data);
    },

    resize(terminalId, cols, rows) {
      requiredTerminal(terminalId).pty.resize(cols, rows);
    },

    close(terminalId) {
      const record = terminals.get(terminalId);

      if (!record) {
        return;
      }

      if (record.status === "running") {
        record.pty.kill();
      }

      terminals.delete(terminalId);
    },

    onEvent(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    disposeAll,
  };
}

function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Pace";

  return env;
}

function appendBounded(scrollback: string, chunk: string, limit: number) {
  const next = scrollback + chunk;

  return next.length > limit ? next.slice(next.length - limit) : next;
}
