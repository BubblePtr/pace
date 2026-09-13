// Environment preflight contracts — first-run readiness checks before the
// primary Agent Workspace flow. Required checks block Continue; optional
// checks never block.

export type EnvironmentPreflightCheckId =
  | "pi_runtime"
  | "data_directory"
  | "model_auth"
  | "git";

export type EnvironmentPreflightCheckSeverity = "required" | "optional";

export type EnvironmentPreflightCheckStatus =
  | "pass"
  | "fail"
  | "skip"
  | "checking";

export type EnvironmentPreflightCheck = {
  id: EnvironmentPreflightCheckId;
  severity: EnvironmentPreflightCheckSeverity;
  status: EnvironmentPreflightCheckStatus;
  title: string;
  summary: string;
  detail?: string;
  remediation?: string[];
  docsUrl?: string;
};

export type EnvironmentPreflightReport = {
  checkedAt: string;
  checks: EnvironmentPreflightCheck[];
  requiredPassed: boolean;
  optionalFailed: boolean;
  canContinue: boolean;
};

export type EnvironmentPreflightStatus = {
  completedAt?: string;
  lastReport?: EnvironmentPreflightReport;
};

export const ENVIRONMENT_PREFLIGHT_DOCS = {
  pi: "https://pi.dev",
} as const;
