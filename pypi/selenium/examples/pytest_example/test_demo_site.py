from selenium.webdriver.common.by import By


def test_login_flow(ptk_driver):
    driver, ptk = ptk_driver

    driver.find_element(By.ID, "uid").send_keys("admin")
    driver.find_element(By.ID, "passw").send_keys("admin")
    driver.find_element(By.NAME, "btnSubmit").click()

    summary = ptk.end_session()
    print("PTK summary:", summary)
    stats = summary.get("stats", {})
    print("PTK findings:", stats.get("vulnsCount", stats.get("findingsCount", 0)))
    assert summary.get("status") == "completed"
