"""An empty OpenAI balance is explained (not retried), skipped by the fallback chain and reported with a code."""
from __future__ import annotations

import httpx
import openai
import pytest

from core.llm import openai_provider
from core.llm.router import CallContext, complete
from core.llm.types import INVALID_KEY, NO_CREDITS, ProviderError
from tests.conftest import drain_jobs
from tests.scripted_provider import STATE, plan_json, resp
from tests.test_orchestration import make_script, send
from tests.test_voice import make_wav


def api_error(cls: type[openai.APIStatusError], status: int, message: str, body: dict | None) -> openai.APIStatusError:
    request = httpx.Request("POST", "https://api.openai.com/v1/x")
    return cls(message, response=httpx.Response(status, request=request), body=body)


# ------------------------------------------------------------------ mapping OpenAI errors
@pytest.mark.parametrize("message,body", [
    ("Error code: 429 - insufficient quota", {"message": "You exceeded your current quota", "type": "insufficient_quota",
                                              "code": "insufficient_quota"}),
    # OpenAI's newer wording, without the machine-readable code
    ("Error code: 429 - You have no credits remaining. Add credits to continue using the API.", None),
])
def test_empty_balance_is_not_retryable_and_explained(message: str, body: dict | None):
    err = openai_provider._map_error(api_error(openai.RateLimitError, 429, message, body))
    assert err.code == NO_CREDITS and err.retryable is False and err.status == 402
    assert "platform.openai.com/settings/organization/billing" in str(err)
    assert "ChatGPT" in str(err)  # the API is billed separately from a ChatGPT subscription


def test_ordinary_rate_limits_are_still_retried():
    err = openai_provider._map_error(api_error(openai.RateLimitError, 429, "Error code: 429 - Rate limit reached",
                                               {"message": "Rate limit reached for requests", "type": "requests",
                                                "code": "rate_limit_exceeded"}))
    assert err.code is None and err.retryable is True and err.status == 429


def test_a_rejected_key_is_explained():
    err = openai_provider._map_error(api_error(openai.AuthenticationError, 401, "Incorrect API key provided",
                                               {"code": "invalid_api_key"}))
    assert err.code == INVALID_KEY and err.retryable is False and "OPENAI_API_KEY" in str(err)


# ------------------------------------------------------------------ the fallback chain
async def test_no_credits_skips_the_other_models_of_the_same_account(client):
    STATE["no_credit_models"] = {"test-model", "test-fallback"}
    STATE["script"] = lambda *_: resp("never used")
    with pytest.raises(ProviderError) as exc:
        await complete(CallContext(user_id=None, purpose="test"), "hi", system="x", model="test-model")
    assert exc.value.code == NO_CREDITS
    assert STATE["calls"].count("test-model") == 1 and "test-fallback" not in STATE["calls"]


# ------------------------------------------------------------------ whole tasks
async def test_a_task_fails_at_once_with_the_reason_instead_of_retrying(client):
    STATE["no_credit_models"] = {"test-model", "test-fallback", "test-fast"}
    STATE["script"] = make_script(plan_json(direct="never"))
    conv_id, task_id = await send(client, "anything")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "FAILED" and "no credits" in (t["error"] or "") and not t["error"].startswith("ProviderError")
    assert t["attempts"] == 1  # a permanent failure: no backoff and retries
    assert STATE["calls"].count("test-model") == 1
    msgs = (await client.get(f"/api/conversations/{conv_id}")).json()["messages"]
    assert "billing" in msgs[-1]["content"]  # the reply tells the user what to do


# ------------------------------------------------------------------ voice endpoints
async def test_voice_endpoints_answer_402_with_a_code_when_the_balance_is_empty(client, monkeypatch):
    class Empty:
        def __init__(self) -> None:
            err = api_error(openai.RateLimitError, 429, "Error code: 429 - You have no credits remaining.", None)

            async def boom(**_: object):
                raise err
            self.audio = type("A", (), {"transcriptions": type("T", (), {"create": staticmethod(boom)}),
                                        "speech": type("S", (), {"create": staticmethod(boom)})})

    monkeypatch.setattr(openai_provider, "get_client", lambda: Empty())
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(1.0), "audio/wav")})
    assert r.status_code == 402 and r.json()["code"] == "no_credits"
    assert "billing" in r.json()["detail"]
    r = await client.post("/api/voice/speak", json={"text": "Hello"})
    assert r.status_code == 402 and r.json()["code"] == "no_credits"


async def test_voice_without_a_key_has_a_code_too(client):
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(1.0), "audio/wav")})
    assert r.status_code == 503 and r.json()["code"] == "not_configured" and "OPENAI_API_KEY" in r.json()["detail"]
