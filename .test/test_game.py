"""End-to-end test for the Local Demo mode (no Firebase needed).

Serves the project on 127.0.0.1:8123, opens two browser tabs (host + guest)
and plays a full 10-question game, then checks results, rematch, language,
theme and the custom-question dashboard.

Run:
    pip install playwright && playwright install msedge
    python .test/test_game.py
"""

import os
import re
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"
EXPECT_LOCAL = os.environ.get("WKHWB_EXPECT_LOCAL", "1") == "1"
TOTAL = 10
errors = []


def watch(page, tag):
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror: {e}"))
    page.on(
        "console",
        lambda m: errors.append(f"[{tag} console] {m.text}") if m.type == "error" else None,
    )


def wait_screen(page, screen_id, timeout=15000):
    page.wait_for_selector("#welcome-intro[hidden]", state="attached", timeout=8000)
    page.wait_for_function(
        "id => document.getElementById(id).classList.contains('active')",
        arg=screen_id,
        timeout=timeout,
    )


def counter_is(page, number, timeout=15000):
    page.wait_for_function(
        """n => {
            const m = document.getElementById('q-counter').textContent.match(/\\d+/g);
            return !!m && Number(m[0]) === n;
        }""",
        arg=number,
        timeout=timeout,
    )


def home_fit(page):
    return page.evaluate(
        """() => {
          const s = document.getElementById('screen-home');
          return {
            vh: window.innerHeight,
            h: s.clientHeight,
            scroll: document.documentElement.scrollHeight,
            homeScroll: s.scrollHeight > s.clientHeight,
          };
        }"""
    )


def assert_home_fits(page, label):
    fit = home_fit(page)
    assert abs(fit["h"] - fit["vh"]) <= 1, f"{label}: home is not 100vh {fit}"
    assert fit["scroll"] <= fit["vh"] + 1, f"{label}: page scrolls {fit}"
    assert not fit["homeScroll"], f"{label}: home content overflows {fit}"
    print(label, fit)


def play_round(host, guest, i):
    host.locator("#options-grid .option-btn").nth(0).click(timeout=15000)
    guest.locator("#options-grid .option-btn").nth(0 if i % 2 == 0 else 1).click(timeout=15000)
    host.wait_for_selector("#reveal-panel:not([hidden])", timeout=15000)
    guest.wait_for_selector("#reveal-panel:not([hidden])", timeout=15000)
    host.locator("#next-btn").click(timeout=15000)


server = subprocess.Popen(
    [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
    cwd=ROOT,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
time.sleep(1.5)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        host_context = browser.new_context(viewport={"width": 414, "height": 896})
        guest_context = host_context if EXPECT_LOCAL else browser.new_context(viewport={"width": 414, "height": 896})
        context = host_context

        # Clear storage once, otherwise a previous run's packs/rooms leak in.
        clear_page = context.new_page()
        for label, width, height in (
            ("Home 360x640", 360, 640),
            ("Home 1280x720", 1280, 720),
            ("Home landscape", 844, 390),
        ):
            clear_page.set_viewport_size({"width": width, "height": height})
            clear_page.goto(BASE, wait_until="networkidle")
            clear_page.wait_for_selector("#screen-home.active", timeout=15000)
            assert_home_fits(clear_page, label)
            clear_page.locator("#lang-km").click()
            clear_page.wait_for_function("() => document.documentElement.lang === 'km'")
            assert_home_fits(clear_page, f"{label} KM")
            clear_page.locator("#lang-en").click()
            clear_page.wait_for_function("() => document.documentElement.lang === 'en'")
        clear_page.goto(BASE)
        clear_page.evaluate("try{localStorage.clear();sessionStorage.clear()}catch(e){}")
        clear_page.close()

        host = context.new_page()
        watch(host, "host")
        host.goto(BASE, wait_until="load")
        wait_screen(host, "screen-home")
        if EXPECT_LOCAL:
            assert host.locator("#local-banner").is_visible(), "local demo banner missing"
        else:
            host.wait_for_selector("#conn-badge:not([hidden])", timeout=30000)
            assert "Online" in host.locator("#conn-text").inner_text()
        host.screenshot(path=os.path.join(ROOT, "test-home.png"))

        print("--- Audio engine ---")
        host.locator("#theme-toggle").click()  # real user gesture so AudioContext can start
        host.locator("#theme-toggle").click()
        audio_state = host.evaluate(
            """async () => {
              const mod = await import('/js/audio.js');
              const e = mod.createAudioEngine();
              e.unlock();
              e.setScene('romantic');
              await new Promise((r) => setTimeout(r, 600));
              const romantic = e.currentScene();
              e.setScene('suspense');
              await new Promise((r) => setTimeout(r, 600));
              const suspense = e.currentScene();
              e.countdown(5000, 'test-key', true);
              const tension = e.currentTension();
              e.reveal(true, 'test-reveal');
              const afterReveal = e.currentScene();
              e.setScene('romantic');
              e.setMuted(true);
              const muted = e.isMuted();
              e.setMuted(false);
              return { romantic, suspense, tension, afterReveal, muted };
            }"""
        )
        assert audio_state["romantic"] == "romantic", audio_state
        assert audio_state["suspense"] == "suspense", audio_state
        if audio_state["tension"] is None:
            print("AudioContext stayed suspended in this headless browser; skipping live audio timing assertion.")
        else:
            assert audio_state["tension"] > 0.5, audio_state
            assert audio_state["afterReveal"] is None, audio_state
        assert audio_state["muted"] is True, audio_state
        print("Audio scenes:", audio_state)

        print("--- Join validation ---")
        host.locator("#home-join-btn").click()
        wait_screen(host, "screen-join")
        host.fill("#join-code", "AB")
        host.locator("#join-room-btn").click()
        assert "6" in host.locator("#join-status").inner_text()
        host.fill("#join-code", "ZZZZZZ")
        host.locator("#join-room-btn").click()
        host.wait_for_function(
            "() => document.getElementById('join-status').className.includes('error')",
            timeout=5000,
        )
        host.wait_for_timeout(2800)  # let the error toast fade before screenshots
        host.locator("#screen-join .back-btn").click()
        wait_screen(host, "screen-home")

        print("--- Host creates a 10-question room ---")
        host.locator("#home-create-btn").click()
        wait_screen(host, "screen-create")
        host.fill("#create-name", "Arjun")
        host.locator('.count-option[data-count="10"]').click()
        host.locator("#create-room-btn").click()
        wait_screen(host, "screen-lobby")
        code = host.locator("#lobby-code").inner_text().strip()
        assert re.fullmatch(r"[A-Z0-9]{6}", code), f"bad room code: {code}"
        print("Room code:", code)
        host.screenshot(path=os.path.join(ROOT, "test-lobby-host.png"))

        guest = guest_context.new_page()
        watch(guest, "guest")
        guest.goto(f"{BASE}/?room={code}", wait_until="load")
        wait_screen(guest, "screen-join")
        guest.fill("#join-name", "Priya")
        guest.locator("#join-room-btn").click()
        wait_screen(guest, "screen-lobby")
        assert "Priya" in guest.locator("#lobby-guest-name").inner_text()
        guest.screenshot(path=os.path.join(ROOT, "test-lobby-guest.png"))

        host.wait_for_function(
            "() => !document.getElementById('lobby-start-btn').disabled", timeout=10000
        )
        print("--- Host starts the game ---")
        host.locator("#lobby-start-btn").click()
        wait_screen(host, "screen-game")
        wait_screen(guest, "screen-game")
        host.wait_for_timeout(500)
        host.screenshot(path=os.path.join(ROOT, "test-game-host.png"))
        guest.screenshot(path=os.path.join(ROOT, "test-game-guest.png"))

        # Alternate host/guest answers -> 5 matches, 5 mismatches -> 50%.
        for i in range(TOTAL):
            counter_is(host, i + 1)
            play_round(host, guest, i)

        print("--- Results ---")
        wait_screen(host, "screen-results", timeout=20000)
        wait_screen(guest, "screen-results", timeout=20000)
        host.wait_for_timeout(2200)
        pct = host.locator("#love-pct").inner_text().strip()
        assert pct == "50%", f"expected 50%, got {pct}"
        assert host.locator("#result-host-score").inner_text().strip() == "5"
        assert host.locator("#best-matches li:not(.empty)").count() == 5
        assert host.locator("#mismatch-list li:not(.empty)").count() == 5
        host.screenshot(path=os.path.join(ROOT, "test-results-host.png"), full_page=True)
        guest.screenshot(path=os.path.join(ROOT, "test-results-guest.png"), full_page=True)
        print("Compatibility:", pct, "| Matches:", host.locator("#result-host-score").inner_text())

        print("--- Score card download ---")
        card_path = os.path.join(tempfile.gettempdir(), "wkhwb-score-card.png")
        with host.expect_download() as dl:
            host.locator("#download-card-btn").click()
        dl.value.save_as(card_path)
        assert os.path.getsize(card_path) > 10000, "score card PNG looks empty"
        print("Score card:", os.path.getsize(card_path), "bytes")

        print("--- Theme + language ---")
        before_theme = host.get_attribute("html", "data-theme")
        host.locator("#theme-toggle").click()
        assert host.get_attribute("html", "data-theme") != before_theme, "theme did not toggle"
        host.locator("#lang-km").click()
        host.wait_for_function("() => document.documentElement.lang === 'km'", timeout=5000)
        assert re.search(r"[\u1780-\u17FF]", host.locator("#compat-title").inner_text())
        host.locator("#lang-en").click()
        host.wait_for_function("() => document.documentElement.lang === 'en'", timeout=5000)

        print("--- Rematch ---")
        host.locator("#rematch-btn").click()
        wait_screen(host, "screen-game", timeout=15000)
        wait_screen(guest, "screen-game", timeout=15000)
        counter_is(host, 1, timeout=10000)
        print("Rematch restarted at question 1")

        print("--- Dashboard (packs + question CRUD) ---")
        dash = context.new_page()
        watch(dash, "dash")
        dash.goto(BASE, wait_until="load")
        wait_screen(dash, "screen-home")
        dash.locator("#home-dashboard-btn").click()
        wait_screen(dash, "screen-dashboard")
        assert dash.locator("#dash-empty").is_visible()

        dash.fill("#question-input", "Where did we first meet?")
        for idx, val in enumerate(["At the park", "At a cafe", "At school", "Online"], start=1):
            dash.fill(f"#option-{idx}", val)
        dash.select_option("#question-category", "memories")
        dash.locator('input[name="preferred"][value="1"]').check()
        dash.locator("#question-submit-btn").click()
        dash.wait_for_selector(".question-item", timeout=5000)
        assert "Where did we first meet?" in dash.locator(".question-item-text").first.inner_text()
        assert dash.locator(".question-chip.pref").count() == 1

        dash.locator(".question-item .edit").first.click()
        assert dash.locator("#question-input").input_value() == "Where did we first meet?"
        dash.fill("#question-input", "Where did we first kiss?")
        dash.locator("#question-submit-btn").click()
        dash.wait_for_function(
            "() => document.querySelector('.question-item-text')?.textContent === 'Where did we first kiss?'",
            timeout=5000,
        )

        dash.locator("#pack-preview-btn").click()
        dash.wait_for_selector("#preview-dialog[open]", timeout=5000)
        assert "Where did we first kiss?" in dash.locator("#preview-list").inner_text()
        dash.locator("#preview-dialog [data-close-dialog]").click()

        dash.locator(".question-item .delete").first.click()
        dash.wait_for_selector("#confirm-dialog[open]", timeout=5000)
        dash.locator("#confirm-yes").click()
        dash.wait_for_function(
            "() => document.querySelectorAll('.question-item').length === 0", timeout=5000
        )
        assert dash.locator("#dash-empty").is_visible()

        dash.locator("#pack-new-btn").click()
        dash.wait_for_selector("#pack-dialog[open]", timeout=5000)
        dash.fill("#pack-name-input", "Anniversary Pack")
        dash.locator("#pack-save-btn").click()
        dash.wait_for_function(
            "() => document.querySelectorAll('#pack-select option').length === 2", timeout=5000
        )
        dash.wait_for_function(
            "() => [...document.querySelectorAll('#pack-select option')].some(o => o.textContent.includes('Anniversary Pack'))",
            timeout=5000,
        )
        # Rename it
        dash.locator("#pack-rename-btn").click()
        dash.wait_for_selector("#pack-dialog[open]", timeout=5000)
        dash.fill("#pack-name-input", "Our Story")
        dash.locator("#pack-save-btn").click()
        dash.wait_for_function(
            "() => [...document.querySelectorAll('#pack-select option')].some(o => o.textContent.includes('Our Story'))",
            timeout=5000,
        )
        dash.screenshot(path=os.path.join(ROOT, "test-dashboard.png"))
        print("Dashboard CRUD + packs OK")

        print("--- Custom-source room + preview + leave ---")
        dash.fill("#question-input", "What is our song?")
        for idx, val in enumerate(["Perfect", "Yellow", "Until I Found You", "Kiss Me"], start=1):
            dash.fill(f"#option-{idx}", val)
        dash.select_option("#question-category", "love")
        dash.locator('input[name="preferred"][value="0"]').check()
        dash.locator("#question-submit-btn").click()
        dash.wait_for_selector(".question-item", timeout=5000)
        dash.locator("#screen-dashboard .back-btn").click()
        wait_screen(dash, "screen-home")
        dash.locator("#home-create-btn").click()
        wait_screen(dash, "screen-create")
        dash.fill("#create-name", "Sokha")
        dash.locator('.segment[data-source="custom"]').click()
        assert dash.locator("#category-row").is_visible()
        dash.locator("#create-room-btn").click()
        wait_screen(dash, "screen-lobby")
        settings = dash.locator("#lobby-settings").inner_text()
        assert "1" in settings, f"expected 1 question, got: {settings}"
        dash.locator("#lobby-preview-btn").click()
        dash.wait_for_selector("#preview-dialog[open]", timeout=5000)
        preview = dash.locator("#preview-list").inner_text()
        assert "What is our song?" in preview and "Perfect" in preview
        assert dash.locator("#preview-list .pref-mark").count() == 1
        dash.locator("#preview-dialog [data-close-dialog]").click()
        dash.locator("#lobby-leave-btn").click()
        dash.wait_for_selector("#confirm-dialog[open]", timeout=5000)
        dash.locator("#confirm-yes").click()
        wait_screen(dash, "screen-home")
        print("Custom source + preview + leave OK")

        browser.close()
finally:
    server.terminate()

if errors:
    print("PAGE ERRORS:\n" + "\n".join(errors))
    sys.exit(1)
print("NO PAGE ERRORS")
print("ALL TESTS PASSED")
