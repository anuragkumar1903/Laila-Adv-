// ─── Project ──────────────────────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  path: string;
  git_remote: string | null;
  framework: string | null;
  languages: string;     // JSON-serialised string[]
  pkg_manager: string | null;
  created_at: number;    // Unix epoch
  last_scanned: number | null;
}

export type FileCategory =
  | 'controller'
  | 'service'
  | 'route'
  | 'model'
  | 'test'
  | 'config'
  | 'schema'
  | 'middleware'
  | 'util'
  | 'other';

export interface ProjectFile {
  id: number;
  project_id: number;
  rel_path: string;
  category: FileCategory;
  language: string | null;
  size_bytes: number | null;
  summary: string | null;
  last_indexed: number;
}

// ─── Session & Tasks ──────────────────────────────────────────────────────

export interface Session {
  id: number;
  project_id: number | null;
  started_at: number;
  ended_at: number | null;
}

export type TaskIntent = 'code' | 'review' | 'research' | 'write' | 'general';
export type TaskStatus  = 'pending' | 'running' | 'done' | 'failed';
export type AgentName   = 'coder' | 'reviewer' | 'researcher' | 'writer' | 'general';

export interface Task {
  id: number;
  session_id: number;
  project_id: number | null;
  intent: TaskIntent;
  agent: AgentName;
  status: TaskStatus;
  input: string;
  output: string | null;
  validation: string | null;   // JSON-serialised ValidationReport
  created_at: number;
  completed_at: number | null;
}

export interface Message {
  id: number;
  task_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
}

// ─── Scanner ──────────────────────────────────────────────────────────────

import type { ExtractedSymbols } from './scanner/detectors/symbols.js';

export interface ScannedFile {
  relPath: string;
  category: FileCategory;
  language: string | null;
  sizeBytes: number;
  hash: string;
  symbols?: ExtractedSymbols;
}

export interface ProjectFileRecord {
  path: string;
  role: FileCategory;
  language: string | null;
  hash: string;
  symbols?: ExtractedSymbols;
}

export interface RouteDefinition {
  method: string;
  path: string;
  handler: string;
}

export interface ScanResult {
  projectName: string;
  framework: string | null;
  languages: string[];
  pkgManager: string | null;
  gitRemote: string | null;
  files: ScannedFile[];
  totalFiles: number;
  reusedFiles: number;
  routes: RouteDefinition[];
  summary: string;
  scannedAt: number;
}

export interface ProjectIndex {
  projectId: number;
  projectName: string;
  projectPath: string;
  framework: string | null;
  languages: string[];
  pkgManager: string | null;
  summary?: string;
  filesMeta?: ProjectFileRecord[];
  routes?: RouteDefinition[];
  files: {
    controllers: string[];
    services: string[];
    routes: string[];
    models: string[];
    tests: string[];
    configs: string[];
    schemas: string[];
    middleware: string[];
    utils: string[];
    other: string[];
  };
  tests?: string[];
  scannedAt: string;
}

// ─── Agents & Context ─────────────────────────────────────────────────────

export interface RelevantFile {
  relPath: string;
  content: string;
  category: FileCategory;
  truncated: boolean;
}

export interface AgentContext {
  userMessage: string;
  projectIndex: ProjectIndex | null;
  projectMemory: string | null;
  gitStatus?: string;
  gitDiff?: string;
  relevantFiles: RelevantFile[];
  skill: string;
  availableSkills?: string;
  history: Message[];
  taskId: number;
}

export interface AgentResponse {
  content: string;
  tokensUsed?: number;
}

// ─── LLM ──────────────────────────────────────────────────────────────────

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_ctx?: number;
  };
}

export interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

// ─── Validation ───────────────────────────────────────────────────────────

export interface ValidationResult {
  step: 'build' | 'lint' | 'test';
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ValidationReport {
  success: boolean;
  results: ValidationResult[];
  totalDurationMs: number;
}

// ─── Skills ───────────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  version: string;
  agent: AgentName;
  content: string;
}

// ─── Shell Tool ───────────────────────────────────────────────────────────

/** A shell command block parsed from an LLM response (```cmd or ```shell fence) */
export interface CommandBlock {
  command: string;      // The raw command string proposed by the LLM
  reason?: string;      // Optional one-line explanation from the LLM
}

/** Result of a permission-gated shell command execution */
export interface CommandResult {
  command: string;
  approved: boolean;    // Whether the user approved execution
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  executedAt: number;   // Unix epoch ms
}

// ─── N8N ──────────────────────────────────────────────────────────────────

export interface N8nEvent {
  event: 'task.completed' | 'validation.failed' | 'session.started' | 'session.ended';
  payload: Record<string, unknown>;
  timestamp: string;
}
