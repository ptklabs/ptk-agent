from ptk_selenium.config import PTKConfig


def test_config_defaults():
    config = PTKConfig()
    assert config.browser == "chrome"
    assert config.install_mode == "profile"
    assert config.profile_name == "Default"
    assert config.extension_xpi_path is None
    assert config.lock_profile is True


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("PTK_BROWSER", "firefox")
    monkeypatch.setenv("PTK_HEADLESS", "1")
    monkeypatch.setenv("PTK_WORKER_ID", "worker-1")
    monkeypatch.setenv("PTK_PROFILE_BASE", "/tmp/ptk-profiles")
    monkeypatch.setenv("PTK_PROFILE_DIR", "/tmp/ptk-profiles/custom")
    monkeypatch.setenv("PTK_PROFILE_NAME", "Profile 2")
    monkeypatch.setenv("PTK_LOCK_PROFILE", "0")
    monkeypatch.setenv("PTK_CHROME_BINARY", "/path/chrome")
    monkeypatch.setenv("PTK_EDGE_BINARY", "/path/edge")
    monkeypatch.setenv("PTK_FIREFOX_BINARY", "/path/firefox")
    monkeypatch.setenv("PTK_EXTENSION_XPI_PATH", "/tmp/ptk.xpi")
    monkeypatch.setenv("PTK_PROJECT", "proj")
    monkeypatch.setenv("PTK_ENGINES", "DAST,IAST")
    monkeypatch.setenv("PTK_POLICY_CODE", "POLICY")
    monkeypatch.setenv("PTK_ARTIFACTS_DIR", "/tmp/artifacts")

    config = PTKConfig.from_env()

    assert config.browser == "firefox"
    assert config.headless is True
    assert config.worker_id == "worker-1"
    assert config.profile_base_dir == "/tmp/ptk-profiles"
    assert config.profile_dir == "/tmp/ptk-profiles/custom"
    assert config.profile_name == "Profile 2"
    assert config.lock_profile is False
    assert config.chrome_binary == "/path/chrome"
    assert config.edge_binary == "/path/edge"
    assert config.firefox_binary == "/path/firefox"
    assert config.extension_xpi_path == "/tmp/ptk.xpi"
    assert config.project == "proj"
    assert config.engines == ["DAST", "IAST"]
    assert config.policy_code == "POLICY"
    assert config.artifacts_dir == "/tmp/artifacts"
