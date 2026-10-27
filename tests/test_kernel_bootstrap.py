import builtins
import json

from omicslab.kernel.manager import _BOOTSTRAP_CODE


def test_variable_inspector_works_without_optional_plotting_dependencies(monkeypatch):
    original = builtins.__import__

    def no_plotting(name, *args, **kwargs):
        if name.startswith("matplotlib"):
            raise ModuleNotFoundError("optional plotting dependencies are absent")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_plotting)
    namespace = {"total": 5}
    exec(_BOOTSTRAP_CODE, namespace)
    assert namespace["_omicslab_plotting_available"] is False
    assert any(item["name"] == "total" for item in json.loads(namespace["__omicslab_list_vars"]()))
    assert json.loads(namespace["__omicslab_var_detail"]("total"))["repr"] == "5"
