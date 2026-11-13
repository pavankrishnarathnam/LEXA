export type TaskStatus = "PENDING" | "PLANNING" | "IN_PROGRESS" | "WAITING_FOR_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";
export type PermissionMode = "read_analyze" | "prepare_approve" | "rule_autonomy";

export interface User {
  id: string; email: string; full_name: string; role: string; permission_mode: PermissionMode;
  settings: Record<string, any>; created_at: string;
  profile: { headline: string; location: string; timezone: string; bio: string; skills: string[];
    education: any[]; employment: any[]; career_preferences: Record<string, any> } | null;
}

export interface PlanStep { id: string; agent: string; instruction: string; depends_on: string[] }

export interface Task {
  id: string; title: string; request: string; status: TaskStatus; assigned_agents: string[]; plan: PlanStep[];
  cost_usd: number; attempts: number; conversation_id: string | null; workflow_id: string | null;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
  error: string | null; output?: string | null; output_preview?: string; logs?: TaskLog[];
  executions?: Execution[]; approvals?: Approval[];
}
export interface TaskLog { at: string; level: string; message: string; agent: string | null; data?: any }
export interface Execution {
  id: string; step_id: string; agent: string; instruction: string; status: TaskStatus; output: string | null;
  error: string | null; tool_calls: { tool: string; args: any; outcome?: string; policy?: string; at: string }[];
  model: string | null; input_tokens: number; output_tokens: number; cost_usd: number;
  started_at: string | null; finished_at: string | null;
}
export interface Approval {
  id: string; task_id: string | null; agent: string; tool: string; summary: string; arguments: Record<string, any>;
  risk_level: string; reason: string; status: string; created_at: string; decided_at: string | null;
  result: any; expires_at: string | null;
}
export interface Agent {
  id: string | null; slug: string; name: string; role: string; description: string; icon: string;
  system_prompt: string; tools: string[]; model: string | null; effort: string | null; enabled: boolean;
  is_builtin: boolean; is_custom: boolean; permission_mode: PermissionMode | null; memory_access: string;
  max_tool_iterations: number; max_cost_usd_per_run: number; autonomy_rules: any[]; web_search: boolean;
  capabilities: string[]; stats?: { runs: number; llm_calls: number; cost_usd: number; tokens: number };
}
export interface ToolInfo { name: string; description: string; risk: string; category: string; integration: string | null }
export interface Conversation { id: string; title: string; archived: boolean; created_at: string; updated_at: string }
export interface Message {
  id: string; role: "user" | "assistant" | "system"; content: string; task_id: string | null;
  attachments: { id: string; filename: string }[]; meta: Record<string, any>; created_at: string;
}
export interface Memory {
  id: string; category: string; content: string; source: string; importance: number; pinned: boolean;
  created_at?: string; updated_at: string | null; score?: number; embedding_model?: string;
}
export interface Integration {
  key: string; name: string; description: string; category: string; auth_type: "oauth2" | "api_key" | "config";
  scopes: string[]; scope_descriptions: string[]; fields: { name: string; label: string; secret: boolean; required: boolean; placeholder: string }[];
  docs_url: string; status: string; oauth_available: boolean | null; account_label: string | null;
  granted_scopes: string[]; last_error: string | null; connected_at: string | null; last_used_at: string | null;
}
export interface Notification { id: string; kind: string; title: string; body: string; link: string | null; severity: string; read: boolean; created_at: string }
export interface Workflow {
  id: string; name: string; description: string; trigger_type: string; cron: string | null; timezone: string;
  event_name: string | null; conditions: any[]; instruction: string; agent_slug: string | null; enabled: boolean;
  next_run_at: string | null; last_run_at: string | null; last_status: string | null; run_count: number;
  webhook_path: string | null; webhook_secret?: string | null;
}
export interface Job {
  id: string; title: string; company: string; location: string; remote_type: string; employment_type: string;
  salary_min: number | null; salary_max: number | null; salary_currency: string | null; url: string | null;
  source: string; description: string; required_skills: string[]; match_score: number | null;
  match_analysis: { score?: number; matched_skills?: string[]; missing_skills?: string[]; preference_notes?: string[] };
  status: string; created_at: string;
}
export interface Application {
  id: string; job_id: string; status: string; cover_letter: string; notes: string; timeline: any[];
  submitted_at: string | null; job: { title: string; company: string; url: string | null } | null;
}
export interface Doc { id: string; filename: string; mime_type: string; size_bytes: number; kind: string; indexed: boolean; created_at: string; chars: number }
