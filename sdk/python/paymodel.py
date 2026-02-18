"""
Paymodel Python SDK — Drop-in OpenAI replacement with crypto payments.

Usage:
    from paymodel import Paymodel

    pm = Paymodel(payer="0xYourAddress")

    # Works exactly like OpenAI's client
    response = pm.chat.completions.create(
        model="llama-3.3-70b",
        messages=[{"role": "user", "content": "Hello!"}]
    )
    print(response.choices[0].message.content)

    # Streaming works too
    stream = pm.chat.completions.create(
        model="deepseek-r1",
        messages=[{"role": "user", "content": "Explain quantum computing"}],
        stream=True
    )
    for chunk in stream:
        if chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="")

    # Check your balance
    print(pm.balance())

    # Deposit PathUSD (after sending on-chain)
    pm.deposit(tx_hash="0x...")
"""

import json
import urllib.request
import urllib.error

DEFAULT_BASE_URL = "https://paymodel.bflynn4141.workers.dev"


class PaymodelError(Exception):
    """Error from the Paymodel API."""
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


class Message:
    def __init__(self, role, content):
        self.role = role
        self.content = content

    def __repr__(self):
        return f"Message(role={self.role!r}, content={self.content!r})"


class Choice:
    def __init__(self, index, message, finish_reason):
        self.index = index
        self.message = message
        self.finish_reason = finish_reason


class Usage:
    def __init__(self, prompt_tokens, completion_tokens, total_tokens):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens


class ChatCompletion:
    def __init__(self, data):
        self._data = data
        self.id = data.get("id", "")
        self.object = data.get("object", "chat.completion")
        self.model = data.get("model", "")
        self.choices = [
            Choice(
                index=c.get("index", i),
                message=Message(
                    role=c.get("message", {}).get("role", "assistant"),
                    content=c.get("message", {}).get("content", ""),
                ),
                finish_reason=c.get("finish_reason"),
            )
            for i, c in enumerate(data.get("choices", []))
        ]
        usage = data.get("usage", {})
        self.usage = Usage(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
        )
        # Paymodel-specific: cost info from headers (populated by caller)
        self.cost = None
        self.balance = None


class DeltaMessage:
    def __init__(self, role=None, content=None):
        self.role = role
        self.content = content


class StreamChoice:
    def __init__(self, index, delta, finish_reason):
        self.index = index
        self.delta = delta
        self.finish_reason = finish_reason


class ChatCompletionChunk:
    def __init__(self, data):
        self.id = data.get("id", "")
        self.object = "chat.completion.chunk"
        self.model = data.get("model", "")
        self.choices = [
            StreamChoice(
                index=c.get("index", i),
                delta=DeltaMessage(
                    role=c.get("delta", {}).get("role"),
                    content=c.get("delta", {}).get("content"),
                ),
                finish_reason=c.get("finish_reason"),
            )
            for i, c in enumerate(data.get("choices", []))
        ]


class ChatCompletions:
    def __init__(self, client):
        self._client = client

    def create(self, model, messages, stream=False, **kwargs):
        body = {"model": model, "messages": messages, "stream": stream, **kwargs}

        if stream:
            return self._stream(body)
        else:
            return self._request(body)

    def _request(self, body):
        data, headers = self._client._post("/v1/chat/completions", body)
        result = ChatCompletion(data)
        result.cost = headers.get("X-Cost")
        result.balance = headers.get("X-Balance")
        return result

    def _stream(self, body):
        url = self._client._base_url + "/v1/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "X-Payer": self._client._payer,
            },
            method="POST",
        )

        resp = urllib.request.urlopen(req)
        buffer = ""

        for raw_line in resp:
            line = raw_line.decode("utf-8")
            buffer += line

            while "\n" in buffer:
                event_line, buffer = buffer.split("\n", 1)
                event_line = event_line.strip()

                if not event_line.startswith("data: "):
                    continue

                payload = event_line[6:]
                if payload == "[DONE]":
                    return

                try:
                    chunk_data = json.loads(payload)
                    yield ChatCompletionChunk(chunk_data)
                except json.JSONDecodeError:
                    continue


class Chat:
    def __init__(self, client):
        self.completions = ChatCompletions(client)


class Paymodel:
    """
    Paymodel client — drop-in replacement for OpenAI's client.

    Args:
        payer: Your Ethereum address (0x...)
        base_url: Paymodel gateway URL (default: production)
    """

    def __init__(self, payer, base_url=None):
        if not payer or not payer.startswith("0x") or len(payer) != 42:
            raise ValueError("payer must be a valid Ethereum address (0x + 40 hex chars)")
        self._payer = payer.lower()
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.chat = Chat(self)

    def balance(self):
        """Check your PathUSD balance."""
        data, _ = self._get("/v1/balance")
        return data

    def deposit(self, tx_hash):
        """Register a PathUSD deposit after sending on-chain."""
        data, _ = self._post("/v1/deposit", {"txHash": tx_hash})
        return data

    def models(self):
        """List available models with pricing."""
        data, _ = self._get("/v1/models")
        return data

    def usage(self):
        """Get your usage history."""
        data, _ = self._get("/v1/usage")
        return data

    def _get(self, path):
        url = self._base_url + path
        req = urllib.request.Request(url, headers={"X-Payer": self._payer})
        try:
            resp = urllib.request.urlopen(req)
            headers = dict(resp.headers)
            return json.loads(resp.read()), headers
        except urllib.error.HTTPError as e:
            body = json.loads(e.read())
            raise PaymodelError(body.get("code", "UNKNOWN"), body.get("error", str(e)), body)

    def _post(self, path, body):
        url = self._base_url + path
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "X-Payer": self._payer,
            },
            method="POST",
        )
        try:
            resp = urllib.request.urlopen(req)
            headers = dict(resp.headers)
            return json.loads(resp.read()), headers
        except urllib.error.HTTPError as e:
            body = json.loads(e.read())
            raise PaymodelError(body.get("code", "UNKNOWN"), body.get("error", str(e)), body)


# ─── Convenience: OpenAI SDK compatibility ─────────────────────────
#
# If you already use the `openai` package, you can use paymodel as a
# drop-in replacement by just changing the base_url and adding a header:
#
#   from openai import OpenAI
#
#   client = OpenAI(
#       base_url="https://paymodel.bflynn4141.workers.dev/v1",
#       api_key="unused",  # paymodel uses X-Payer, not API keys
#       default_headers={"X-Payer": "0xYourAddress"}
#   )
#
#   response = client.chat.completions.create(
#       model="llama-3.3-70b",
#       messages=[{"role": "user", "content": "Hello!"}]
#   )
