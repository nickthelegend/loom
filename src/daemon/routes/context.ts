import type { Request, RequestHandler, Response } from 'express';
import type { ApprovalDecision } from '../../core/approvals.js';
import type { Release } from '../../core/updater.js';
import type { AuthManager } from '../auth.js';
import type { ProjectRuntime } from '../runtime.js';
import type { SpecRunner } from '../specs.js';
import type { TeamLink } from '../team.js';
import type { TerminalManager } from '../terminals.js';

/** Capabilities supplied by the daemon; route groups receive only their subset. */
export interface RouteContext {
  terminals: TerminalManager;
  auth: AuthManager;
  askHuman: (req: { project: string; agent: string; tool: string; input: unknown; summary?: string; }) => Promise<ApprovalDecision>;
  cachedRelease: (refresh: boolean) => Promise<Release | null>;
  updating: boolean;
  close: () => Promise<void>;
  exposedIps: () => string[];
  host: string;
  port: number;
  expose: (ip: string) => Promise<void>;
  /** The link's cloud part, carrying this device's own relay key. */
  cloudLinkParams: (relayKey: string) => string;
  team: TeamLink;
  runtimes: Map<string, ProjectRuntime>;
  cloudStatus: () => Record<string, unknown>;
  startCloud: () => Promise<void>;
  stopCloud: (opts?: { rotate?: boolean; }) => Promise<void>;
  pushTokens: () => string[];
  runtime: (idOrName: string) => Promise<ProjectRuntime>;
  specRunner: SpecRunner;
  startHealLoop: (rt: ProjectRuntime, agent: string, alert: string, since: number) => void;
  broadcastTerm: (projectId: string, frame: Record<string, unknown>) => void;
  approvals: Map<string, { id: string; projectId: string; agent: string; tool: string; input: unknown; sessionOption?: boolean; createdAt: number; settle: (d: ApprovalDecision) => void; }>;
}
export type WithRuntime = (handler: (rt: ProjectRuntime, req: Request, res: Response) => Promise<void>) => RequestHandler;
