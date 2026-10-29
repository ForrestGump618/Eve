"""Default-open permissions, model verification defaults and richer capability validation."""
from omicslab.suwen.configuration import Configuration, DEFAULTS


def _store():
    class Row:
        def __init__(self, value):
            self.value = value
            self.revision = 1

    class Store:
        def __init__(self):
            self.records = {}
            self.history = {}

        def get(self, kind, key, scope="global"):
            return self.records.get((kind, key, scope))

        def put(self, kind, key, value, scope="global", expected=0):
            self.records[(kind, key, scope)] = {"value": value["value"], "revision": 1}
            return {"revision": 1}

        def audit(self, *args, **kwargs):
            return None

    return Store()


def test_permissions_default_to_allow_all():
    permissions = DEFAULTS["permissions"]
    for key, value in permissions.items():
        if key == "tools":
            assert value == {}
        else:
            assert value == "allow", key


def test_models_defaults_include_verification_and_agent_teams():
    models = DEFAULTS["models"]
    assert models["verification"] == "standard"
    assert models["orchestration"] is True
    assert models["sage_verification"] is False


def test_capabilities_accept_numeric_temperature_context_and_modalities():
    store = _store()
    config = Configuration(store)
    config.update("models", {"capabilities": {
        "deepseek-chat": {
            "temperature": 0.7,
            "context_window": 64000,
            "max_output": 8192,
            "modalities": ["text", "image"],
            "token_parameter": "max_tokens",
            "supported_parameters": ["temperature", "max_tokens"],
        }
    }})
    value = config.get("models")["value"]["capabilities"]["deepseek-chat"]
    assert value["temperature"] == 0.7
    assert value["context_window"] == 64000
    assert value["modalities"] == ["text", "image"]


def test_capabilities_reject_invalid_modalities_and_context():
    store = _store()
    config = Configuration(store)
    for patch in (
        {"capabilities": {"m": {"modalities": ["video"]}}},
        {"capabilities": {"m": {"context_window": 100}}},
        {"capabilities": {"m": {"temperature": 7}}},
    ):
        try:
            config.update("models", patch)
        except ValueError:
            continue
        raise AssertionError(f"expected rejection for {patch}")


def test_models_default_verification_maps_to_standard():
    store = _store()
    config = Configuration(store)
    value = config.get("models")["value"]
    assert value["verification"] == "standard"
    assert value["sage_verification"] is False
