export type ChangelogRelease = {
  version: string;
  /** Release calendar date, kept stable across the reader's time zone. */
  date: string;
  title: string;
  summary: string;
  url: string;
  changes: readonly {
    kind: "added" | "improved" | "fixed";
    title: string;
    description: string;
  }[];
};

// Ship release notes with the app so the history is also available offline.
export const changelogReleases: readonly ChangelogRelease[] = [
  {
    version: "0.0.9",
    date: "2026-09-14",
    title: "Instant history, isolated sessions",
    summary: "Past sessions open without waiting for Pi, every running session gets its own process, and extensions no longer need a system Node.js.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.9",
    changes: [
      {
        kind: "improved",
        title: "Session history opens instantly",
        description: "Reopening a past session shows its timeline right away from the local journal. Pi and its extensions start only when you send a message, queue one, or switch models.",
      },
      {
        kind: "improved",
        title: "Isolated session processes",
        description: "Each running session gets its own Pi process and working directory, so projects no longer leak plugin state into each other and a crashed session leaves the others running.",
      },
      {
        kind: "improved",
        title: "Extensions without extra setup",
        description: "Background extensions such as pi-subagents run inside the session's own runtime; installing Node.js 22.19+ separately is no longer required.",
      },
    ],
  },
  {
    version: "0.0.8",
    date: "2026-09-13",
    title: "Quieter fixes",
    summary: "Utility icons stay still, failed tools keep to one line, and ordinary inputs get their own borders back.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.8",
    changes: [
      {
        kind: "fixed",
        title: "Static utility icons",
        description: "The Add Project button and the project and session overflow menus show still icons again instead of animating on hover.",
      },
      {
        kind: "fixed",
        title: "One-line failed tools",
        description: "A failed tool call no longer wraps its status and duration onto a second line in the trajectory.",
      },
      {
        kind: "fixed",
        title: "Input elevation restored",
        description: "Ordinary text inputs return to their default border and focus styles, while the chat composer keeps a subtle outer shadow of its own.",
      },
    ],
  },
  {
    version: "0.0.7",
    date: "2026-09-12",
    title: "A steadier workspace",
    summary: "Shell icons animate on hover, pane headers line up, and background sessions no longer steal the Live Chat.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.7",
    changes: [
      {
        kind: "improved",
        title: "Animated shell icons",
        description: "Sidebar, header and Settings navigation icons play a short animation on hover, staying still for touch, disabled and reduced-motion states.",
      },
      {
        kind: "improved",
        title: "Aligned pane headers",
        description: "The Trajectory title and refresh action move into the left pane header, both panes share one header line and divider, and the session list is simpler.",
      },
      {
        kind: "improved",
        title: "Quieter sidebar actions",
        description: "Row action buttons signal hover with icon color alone, keeping the row background steady.",
      },
      {
        kind: "fixed",
        title: "Live Chat stays put",
        description: "Viewing a finished session is no longer interrupted by events from a running one, and late replies no longer write into a session you switched away from.",
      },
      {
        kind: "fixed",
        title: "Background extensions run on system Node",
        description: "Extensions with background runners such as pi-subagents now launch through the machine's own Node.js 22.19+. Preflight shows the detected Node or how to fix it, and regular sessions keep working without it.",
      },
    ],
  },
  {
    version: "0.0.6",
    date: "2026-09-11",
    title: "A tidier session list",
    summary: "Sessions order by your last message, the list header is simpler, and stale state no longer revives finished tools.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.6",
    changes: [
      {
        kind: "improved",
        title: "Sessions ordered by your last message",
        description: "The sidebar sorts sessions by when you last sent a message instead of grouping by run state.",
      },
      {
        kind: "improved",
        title: "Simpler session list header",
        description: "The session list drops its edge fades and extra header chrome.",
      },
      {
        kind: "fixed",
        title: "Finished tools stay finished",
        description: "A stale projection could rewind the conversation and show completed tools as running again, erasing their results. Out-of-order state is now ignored.",
      },
      {
        kind: "fixed",
        title: "Session titles stay clear of the dock",
        description: "Long session titles are constrained so they no longer cover the dock.",
      },
      {
        kind: "fixed",
        title: "Drafts keep a clean slate",
        description: "Background updates from a session still being created no longer leak into a new draft.",
      },
    ],
  },
  {
    version: "0.0.5",
    date: "2026-09-11",
    title: "Follow changes from chat",
    summary: "Open changed files from chat, keep workspace changes fresh, and see when a session is resuming.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.5",
    changes: [
      {
        kind: "added",
        title: "Chat links open Changes",
        description: "Click a changed file link in chat to open the Changes dock and jump to that file's diff.",
      },
      {
        kind: "improved",
        title: "Workspace changes stay current",
        description: "Changes refreshes after agent activity and Git metadata changes, including commits, staging and branch switches outside Pace.",
      },
      {
        kind: "improved",
        title: "Session resume status",
        description: "A status line shows when a session is resuming while its runtime snapshot loads.",
      },
      {
        kind: "improved",
        title: "Simpler Changes and Files panels",
        description: "Flatter layouts give file content more room, with consistent empty states across the dock.",
      },
      {
        kind: "fixed",
        title: "Correct branch after creating a worktree",
        description: "The branch selector waits for the session runtime to bind before reading its branch.",
      },
      {
        kind: "fixed",
        title: "Trajectory headers stay aligned",
        description: "Sticky run headers keep their position while you scroll through the trajectory.",
      },
      {
        kind: "fixed",
        title: "Visible update indicators in Settings",
        description: "Settings navigation now shows when an app update is available.",
      },
      {
        kind: "fixed",
        title: "Browser views after window reload",
        description: "Reloading the app window hides native browser views until the dock reopens, while keeping their tabs and pages alive.",
      },
      {
        kind: "fixed",
        title: "Smaller session journals",
        description: "Cumulative tool-output updates are no longer written repeatedly to the session journal. Live output and completed tool results remain available.",
      },
    ],
  },
  {
    version: "0.0.4",
    date: "2026-09-10",
    title: "Discover and manage Pi packages",
    summary: "Find Pi packages in the new marketplace, manage their resources, and work more comfortably in the Changes and Files panels.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.4",
    changes: [
      {
        kind: "added",
        title: "Packages marketplace",
        description: "Open Packages from the sidebar to browse the npm Pi package catalog. Explore themed collections, search across pages, and switch between Discover, Installed and Updates.",
      },
      {
        kind: "added",
        title: "Package and resource management",
        description: "Install, update and remove packages, enable or disable their resources, and import local extensions, skills, prompts and themes.",
      },
      {
        kind: "added",
        title: "Resource details and diagnostics",
        description: "Inspect where resources come from, check available package updates, and review extension errors from the most recently active session.",
      },
      {
        kind: "improved",
        title: "Clearer Files layout",
        description: "The directory tree sits to the right of the file preview in wider windows, with simpler styling and a clearer Files dock icon.",
      },
      {
        kind: "improved",
        title: "Easier marketplace browsing",
        description: "Package card titles stay on one line with clearer hover feedback, and the search input uses a more readable text size.",
      },
      {
        kind: "fixed",
        title: "Changes panel in narrow windows",
        description: "Changes keeps a compact layout in narrow windows, header controls remain usable while scrolling, and clearing all changes shows the empty state correctly.",
      },
    ],
  },
  {
    version: "0.0.3",
    date: "2026-09-09",
    title: "PiGUI becomes Pace",
    summary: "The app is now called Pace, with a new icon, a Files surface, stacked diffs, and automatic migration of your existing data.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.3",
    changes: [
      {
        kind: "added",
        title: "Pace identity",
        description: "New name, app icon and wordmark. The GitHub repository moved to BubblePtr/pace; old links redirect.",
      },
      {
        kind: "added",
        title: "Files surface",
        description: "Browse the Session checkout as a read-only tree with file preview from the dock, next to Changes, Terminal and Browser.",
      },
      {
        kind: "added",
        title: "Stacked diffs in Changes",
        description: "Every changed file is stacked in one scrollable view with an outline, collapse and expand controls, and unified diffs.",
      },
      {
        kind: "improved",
        title: "Data migration",
        description: "On first launch Pace moves ~/.pigui to ~/.pace and the Electron profile to Application Support/Pace, keeping sessions, project registry and drafts. PIGUI_DATA_DIR still works as a deprecated alias of PACE_DATA_DIR.",
      },
      {
        kind: "improved",
        title: "Quieter sidebar",
        description: "Section and row actions appear on hover, and the session header follows the session name with a normal weight.",
      },
      {
        kind: "fixed",
        title: "Draft to Live handoff",
        description: "A new session opens as Live as soon as it is created instead of waiting for Pi to accept the first prompt.",
      },
      {
        kind: "fixed",
        title: "Input method Enter",
        description: "Confirming a candidate in a CJK input method no longer sends the message.",
      },
      {
        kind: "fixed",
        title: "Dense trajectory strip",
        description: "Very long trajectories no longer overflow the strip horizontally.",
      },
    ],
  },
  {
    version: "0.0.2",
    date: "2026-09-08",
    title: "Chat freely, stay up to date",
    summary: "Start a conversation without a project, update PiGUI in the app, and find sessions more easily.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.2",
    changes: [
      {
        kind: "added",
        title: "Projectless Chat",
        description: "Start a chat without choosing a repository. Manage chats in their own sidebar group and configure their workspace in Settings.",
      },
      {
        kind: "added",
        title: "In-app updates",
        description: "Check, download, and install future releases from About & Updates, with update indicators in the sidebar and an entry in the macOS app menu. Upgrade from v0.0.1 manually once to enable this.",
      },
      {
        kind: "added",
        title: "Release history",
        description: "Read release notes in Settings, even offline, and open the full release on GitHub.",
      },
      {
        kind: "improved",
        title: "Settings in place",
        description: "Open Settings in a dialog while keeping your current session and unsent draft in place.",
      },
      {
        kind: "improved",
        title: "Find your trajectory",
        description: "Filter sessions by presence, switch between recent and project ordering, identify archived sessions, and open a trajectory from the sidebar.",
      },
      {
        kind: "fixed",
        title: "More predictable chat interactions",
        description: "Session titles follow Pi name changes, the branch selector appears after creating a project session, and single tool calls expand with one click. New Chat navigation, workspace recovery, and chat styling are more consistent.",
      },
      {
        kind: "fixed",
        title: "Explicit browser and terminal creation",
        description: "Opening an empty dock surface no longer creates a browser tab or terminal automatically; create one when you need it.",
      },
    ],
  },
  {
    version: "0.0.1",
    date: "2026-09-06",
    title: "A workspace for Pi",
    summary: "The first PiGUI release brings Pi Agent to your macOS desktop.",
    url: "https://github.com/BubblePtr/pace/releases/tag/v0.0.1",
    changes: [
      {
        kind: "added",
        title: "Projects and sessions",
        description: "Create, resume, and manage Pi sessions by project.",
      },
      {
        kind: "added",
        title: "Chat and trajectory",
        description: "Follow conversations, inspect tool calls, and see token usage and costs.",
      },
      {
        kind: "added",
        title: "Browser and terminal",
        description: "Preview pages in browser tabs, send page annotations to your session, and work in the built-in terminal.",
      },
      {
        kind: "added",
        title: "Providers and models",
        description: "Connect your providers, choose a model, and adjust its thinking level.",
      },
    ],
  },
];
