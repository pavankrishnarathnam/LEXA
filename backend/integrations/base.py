"""Integration provider registry."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class CredentialField:
    name: str
    label: str
    secret: bool = True
    required: bool = True
    placeholder: str = ""


@dataclass(frozen=True)
class ProviderSpec:
    key: str
    name: str
    description: str
    category: str
    auth_type: Literal["oauth2", "api_key", "config"]
    scopes: tuple[str, ...] = ()
    scope_descriptions: tuple[str, ...] = ()
    fields: tuple[CredentialField, ...] = ()
    oauth_family: str | None = None  # "google" | "github"
    docs_url: str = ""
    supports_disconnect_revoke: bool = False
    tools: tuple[str, ...] = field(default_factory=tuple)


GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"  # noqa: S105 - URL, not a secret
GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke"

PROVIDERS: dict[str, ProviderSpec] = {
    p.key: p
    for p in [
        ProviderSpec("anthropic", "Anthropic Claude", "Primary intelligence provider (server-side API key).",
                     "ai", "config", docs_url="https://docs.claude.com"),
        ProviderSpec("openai", "OpenAI", "Secondary model provider, embeddings and voice (server-side API key).",
                     "ai", "config", docs_url="https://platform.openai.com/docs"),
        ProviderSpec("gmail", "Gmail", "Read, draft and send authorized email.", "communication", "oauth2",
                     scopes=("https://www.googleapis.com/auth/gmail.modify",),
                     scope_descriptions=("Read, draft, label and send email (no permanent deletion)",),
                     oauth_family="google", supports_disconnect_revoke=True,
                     docs_url="https://developers.google.com/gmail/api"),
        ProviderSpec("google_calendar", "Google Calendar", "Read and manage authorized calendar events.",
                     "productivity", "oauth2", scopes=("https://www.googleapis.com/auth/calendar.events",),
                     scope_descriptions=("View and edit events on your calendars",), oauth_family="google",
                     supports_disconnect_revoke=True),
        ProviderSpec("google_drive", "Google Drive", "Search and read authorized Drive files.", "productivity",
                     "oauth2", scopes=("https://www.googleapis.com/auth/drive.readonly",),
                     scope_descriptions=("Read-only access to Drive files",), oauth_family="google",
                     supports_disconnect_revoke=True),
        ProviderSpec("github", "GitHub", "Repositories, issues, branches and pull requests.", "developer",
                     "oauth2", scopes=("repo", "read:user"),
                     scope_descriptions=("Full control of repositories you authorize", "Read profile"),
                     oauth_family="github",
                     fields=(CredentialField("token", "Fine-grained personal access token (alternative to OAuth)"),),
                     docs_url="https://docs.github.com/rest"),
        ProviderSpec("whatsapp", "WhatsApp Business", "WhatsApp Business Cloud API messaging.", "communication",
                     "api_key", fields=(
                         CredentialField("access_token", "Permanent access token"),
                         CredentialField("phone_number_id", "Phone number ID", secret=False),
                         CredentialField("business_account_id", "WhatsApp Business Account ID", secret=False,
                                         required=False)),
                     docs_url="https://developers.facebook.com/docs/whatsapp/cloud-api"),
        ProviderSpec("twilio", "Twilio", "SMS and voice workflows.", "communication", "api_key", fields=(
            CredentialField("account_sid", "Account SID", secret=False),
            CredentialField("auth_token", "Auth token"),
            CredentialField("from_number", "From number (E.164)", secret=False)),
            docs_url="https://www.twilio.com/docs"),
        ProviderSpec("exotel", "Exotel", "Indian telephony and SMS workflows.", "communication", "api_key", fields=(
            CredentialField("account_sid", "Account SID", secret=False),
            CredentialField("api_key", "API key"),
            CredentialField("api_token", "API token"),
            CredentialField("subdomain", "API subdomain (e.g. api.exotel.com)", secret=False),
            CredentialField("caller_id", "ExoPhone / sender ID", secret=False)),
            docs_url="https://developer.exotel.com"),
        ProviderSpec("n8n", "n8n", "Trigger n8n workflows and receive their callbacks.", "automation", "api_key",
                     fields=(CredentialField("base_url", "n8n base URL", secret=False,
                                             placeholder="https://n8n.example.com"),
                             CredentialField("api_key", "n8n API key", required=False)),
                     docs_url="https://docs.n8n.io"),
        ProviderSpec("mcp", "MCP servers", "Connect a remote MCP server (Streamable HTTP).", "automation",
                     "api_key", fields=(CredentialField("url", "Server URL", secret=False),
                                        CredentialField("bearer_token", "Bearer token", required=False),
                                        CredentialField("read_only", "Read-only server? (true/false)",
                                                        secret=False, required=False)),
                     docs_url="https://modelcontextprotocol.io"),
    ]
}
