#!/usr/bin/env python3
"""
Recreation.gov reservation booking agent.

Waits until 10:00 AM PT, then attempts to book a ticket at:
  https://www.recreation.gov/ticket/253731/ticket/255

Tickets open 2 days in advance of the visit date, so the target visit date
is always today + 2 days when you run this at 10 AM PT.

Usage:
    cp .env.example .env        # fill in your credentials
    python3 book.py             # runs and waits for 10 AM PT
    python3 book.py --now       # skip the wait (for testing)
    python3 book.py --date 6/25/2026  # target a specific visit date
"""

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TICKET_URL = "https://www.recreation.gov/ticket/253731/ticket/255"
FACILITY_ID = "253731"
TICKET_ID = "255"

# Pacific Time offset (handles both PST −8 and PDT −7 automatically via pytz
# if available, otherwise we fall back to a fixed −7 for summer / −8 for winter).
try:
    import zoneinfo
    PT = zoneinfo.ZoneInfo("America/Los_Angeles")
except ImportError:
    PT = None  # fall back to manual offset

RELEASE_HOUR_PT = 10   # tickets drop at 10:00 AM PT
RETRY_INTERVAL_S = 0.3  # seconds between add-to-cart attempts
MAX_CHECKOUT_WAIT = 120  # seconds to wait for checkout page elements
LOG_LEVEL = logging.INFO

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("book")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def pt_now() -> datetime:
    """Return the current wall-clock time in PT (aware datetime)."""
    if PT:
        return datetime.now(tz=PT)
    # Manual fallback: detect DST crudely by month (Mar–Nov = PDT)
    utc = datetime.now(tz=timezone.utc)
    month = utc.month
    offset = timedelta(hours=-7 if 3 <= month <= 11 else -8)
    pt_tz = timezone(offset)
    return utc.astimezone(pt_tz)


def visit_date_str(override: str | None) -> str:
    """
    Return the visit date string in M/D/YYYY format.
    If override is provided, use it; otherwise use today + 2 days (PT).
    """
    if override:
        return override
    target = pt_now().date() + timedelta(days=2)
    return f"{target.month}/{target.day}/{target.year}"


def wait_for_release():
    """Block until 10:00:00 AM PT (or very close to it)."""
    now = pt_now()
    release = now.replace(hour=RELEASE_HOUR_PT, minute=0, second=0, microsecond=0)
    if now >= release:
        log.info("Already past 10:00 AM PT — proceeding immediately.")
        return

    wait_s = (release - now).total_seconds()
    log.info(
        "Current PT time: %s  |  Release at: %s  |  Waiting %.0f s…",
        now.strftime("%H:%M:%S"),
        release.strftime("%H:%M:%S"),
        wait_s,
    )

    # Sleep in chunks; wake up 2 seconds early for final spin-wait
    while True:
        remaining = (release - pt_now()).total_seconds()
        if remaining <= 2:
            break
        time.sleep(min(remaining - 2, 30))

    # Spin-wait for the last 2 seconds to hit the exact moment
    while pt_now() < release:
        time.sleep(0.05)

    log.info("It's 10:00 AM PT — GO!")


# ---------------------------------------------------------------------------
# Booking logic
# ---------------------------------------------------------------------------

def load_env():
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    email = os.environ.get("RECGOV_EMAIL", "")
    password = os.environ.get("RECGOV_PASSWORD", "")
    if not email or not password:
        log.error(
            "Set RECGOV_EMAIL and RECGOV_PASSWORD in reservation_agent/.env "
            "(copy .env.example and fill in your credentials)."
        )
        sys.exit(1)
    return email, password


def login(page, email: str, password: str):
    log.info("Navigating to recreation.gov…")
    page.goto("https://www.recreation.gov", wait_until="domcontentloaded", timeout=45_000)
    page.screenshot(path="homepage.png")
    log.info("Homepage loaded. Looking for Sign In…")

    # Try every known Sign In selector in order
    sign_in_selectors = [
        "text=Sign In",
        "text=Log In",
        "a[href*='signin']",
        "a[href*='login']",
        "button:has-text('Sign In')",
        "button:has-text('Log In')",
        "[data-component='login-button']",
        "[aria-label*='Sign In']",
        "[aria-label*='Log In']",
    ]
    clicked = False
    for sel in sign_in_selectors:
        try:
            page.click(sel, timeout=3_000)
            log.info("Clicked Sign In via: %s", sel)
            clicked = True
            break
        except PWTimeout:
            continue

    if not clicked:
        page.screenshot(path="signin_not_found.png")
        raise RuntimeError("Could not find Sign In button — see signin_not_found.png")

    page.wait_for_selector("input[name='email'], input[type='email']", timeout=15_000)
    log.info("Filling in credentials…")
    page.fill("input[name='email'], input[type='email']", email)
    page.fill("input[name='password'], input[type='password']", password)
    page.click("button[type='submit']")

    # Wait for login to complete (header changes, no login button visible)
    try:
        page.wait_for_selector(
            "[data-component='user-menu'], .username, [aria-label='My Account']",
            timeout=20_000,
        )
        log.info("Logged in successfully.")
    except PWTimeout:
        # Some flows redirect without a visible user menu — check URL instead
        if "signin" not in page.url and "login" not in page.url:
            log.info("Login appears complete (redirected away from sign-in).")
        else:
            log.warning("Could not confirm login — proceeding anyway.")


def add_to_cart(page, date_str: str) -> bool:
    """Navigate to the ticket page and attempt to add to cart. Returns True on success."""
    url = f"{TICKET_URL}?date={date_str}"
    log.info("Loading ticket page: %s", url)
    page.goto(url, wait_until="domcontentloaded", timeout=30_000)

    # Wait for the page to render tickets
    try:
        page.wait_for_selector(
            "button:has-text('Add to Cart'), button:has-text('Book'), .sarsa-button--primary",
            timeout=15_000,
        )
    except PWTimeout:
        log.warning("Ticket page took too long to load — retrying…")
        return False

    # Click Add to Cart (or equivalent primary CTA)
    btn = page.query_selector("button:has-text('Add to Cart')")
    if not btn:
        btn = page.query_selector("button:has-text('Book Now'), button:has-text('Reserve')")
    if not btn:
        # Try the primary sarsa button
        btn = page.query_selector(".sarsa-button--primary")

    if not btn:
        log.warning("No 'Add to Cart' button found — tickets may not be released yet.")
        return False

    if btn.is_disabled():
        log.info("Button found but disabled — tickets not available yet.")
        return False

    log.info("Clicking 'Add to Cart'…")
    btn.click()

    # Check for a cart confirmation or a quantity selector
    try:
        page.wait_for_selector(
            ".cart-confirmation, [data-component='cart'], a[href*='/cart'], "
            "text=item added, .quantity-selector",
            timeout=8_000,
        )
        log.info("Added to cart!")
        return True
    except PWTimeout:
        # Might have already navigated to cart
        if "/cart" in page.url or "checkout" in page.url:
            log.info("Navigated to cart/checkout directly.")
            return True
        log.info("Cart confirmation not detected — will retry.")
        return False


def checkout(page, email: str):
    """Proceed through checkout to place the order."""
    log.info("Proceeding to checkout…")

    # Navigate to cart if not already there
    if "/cart" not in page.url and "checkout" not in page.url:
        try:
            page.click("a[href*='/cart'], button:has-text('View Cart'), a:has-text('Cart')", timeout=8_000)
        except PWTimeout:
            page.goto("https://www.recreation.gov/cart", wait_until="domcontentloaded", timeout=30_000)

    # Click Checkout / Proceed
    try:
        page.click(
            "button:has-text('Checkout'), button:has-text('Proceed'), a:has-text('Checkout')",
            timeout=MAX_CHECKOUT_WAIT * 1_000,
        )
    except PWTimeout:
        log.error("Checkout button not found. Saving screenshot.")
        page.screenshot(path="checkout_error.png")
        return

    # Fill in any required visitor information fields
    try:
        page.wait_for_selector(
            "input[name*='first'], input[name*='First'], "
            "input[placeholder*='First'], .checkout-form",
            timeout=20_000,
        )
        # Attempt to fill common required fields; the site may pre-populate from account
        for sel, val in [
            ("input[name*='first'], input[placeholder*='First']", email.split("@")[0]),
        ]:
            el = page.query_selector(sel)
            if el and not el.input_value():
                el.fill(val)
    except PWTimeout:
        pass  # Fields may already be filled from account data

    # Final "Place Order" / "Complete Purchase"
    try:
        page.click(
            "button:has-text('Place Order'), button:has-text('Complete'), "
            "button:has-text('Confirm'), button:has-text('Submit')",
            timeout=30_000,
        )
        page.wait_for_selector(
            "text=confirmation, text=Confirmation, text=Order Number, .order-confirmation",
            timeout=30_000,
        )
        log.info("ORDER PLACED SUCCESSFULLY!")
        page.screenshot(path="booking_confirmation.png")
        log.info("Screenshot saved to booking_confirmation.png")
    except PWTimeout:
        log.error("Could not confirm order placement. Saving screenshot.")
        page.screenshot(path="booking_error.png")
        log.info("Screenshot saved to booking_error.png")


def run(skip_wait: bool, date_override: str | None, headless: bool):
    email, password = load_env()
    date_str = visit_date_str(date_override)
    log.info("Target visit date: %s", date_str)

    if not skip_wait:
        wait_for_release()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()

        try:
            login(page, email, password)

            success = False
            attempt = 0
            while not success:
                attempt += 1
                log.info("Add-to-cart attempt #%d…", attempt)
                success = add_to_cart(page, date_str)
                if not success:
                    time.sleep(RETRY_INTERVAL_S)

            checkout(page, email)
        except Exception as exc:
            log.error("Unexpected error: %s", exc, exc_info=True)
            try:
                page.screenshot(path="error.png")
                log.info("Screenshot saved to error.png")
            except Exception:
                pass
            sys.exit(1)
        finally:
            browser.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Recreation.gov reservation bot")
    parser.add_argument(
        "--now", action="store_true",
        help="Skip waiting for 10 AM PT and run immediately (for testing).",
    )
    parser.add_argument(
        "--date", default=None, metavar="M/D/YYYY",
        help="Override the visit date (default: today + 2 days in PT).",
    )
    parser.add_argument(
        "--no-headless", action="store_true",
        help="Show the browser window (useful for debugging).",
    )
    args = parser.parse_args()

    run(
        skip_wait=args.now,
        date_override=args.date,
        headless=not args.no_headless,
    )


if __name__ == "__main__":
    main()
