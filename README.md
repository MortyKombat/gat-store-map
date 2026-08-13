# Gat Avigdor Store Map

Unofficial interactive map for the stores listed by Gat Avigdor's public store locator.

## What it does

- Plots every store returned by the source locator.
- Click or drag a pin to choose any location in Israel.
- Sorts stores by straight-line distance from that pin.
- Filters by store name, address, city, ZIP, or phone.
- Refreshes the source data automatically every 6 hours through GitHub Actions.

## Hosting

The project is designed for GitHub Pages. The workflow in `.github/workflows/pages.yml` fetches the latest store data, creates a static Pages artifact, and deploys it.

For GitHub Free, the repository must be **public** for GitHub Pages. After making the repository public, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions** if GitHub has not selected it automatically.

Expected project URL:

`https://mortykombat.github.io/gat-store-map/`

## Data source

Store data is read from Gat Avigdor's public WP Store Locator AJAX endpoint used by:

`https://gatavigdor.co.il/where-gat/`

This project is not affiliated with Gat Avigdor.
