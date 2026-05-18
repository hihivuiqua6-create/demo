# Changelog

## v3.1.0 — UI overhaul

### Fixed
- Admin dashboard rendered as a blank page because legacy inline light-theme styles fought the new dark `app.css` design system. Removed the inline `<style>` blocks from `public/admin.html` and `public/seller.html`.

### Changed
- Admin and Seller panels rewritten to use the dark, glassmorphism design system from `public/app.css` (matches the login page).
- All emoji icons replaced with pure-CSS SVG-mask icons from the built-in icon library (`<i class="i ic-...">`).
- Sidebar nav, cards, panels, tables, badges, buttons, modals and toasts all use design-system tokens — no light-mode anywhere.
- Added `.modal`, `.acc`, `.chk`, `.grid2/3`, `.msg-list`, `.pill-tabs`, `.tcode` and other component styles in `app.css`.

## v3.0.0
- Multi-bot, auto-reply, ZIP hosting, seller expiry, bulk-message tools.
