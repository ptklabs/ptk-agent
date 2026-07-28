import pytest
from ptk_selenium import PTKConfig, ptk_session


@pytest.fixture
def ptk_driver(request):
    config = PTKConfig.from_env()
    target = request.config.getoption("--target-url", default=None)

    with ptk_session(config, target_url=target) as session:
        yield session


def pytest_addoption(parser):
    parser.addoption("--target-url", default=None, help="Target URL for PTK scans")
