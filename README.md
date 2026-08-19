# Taxi Card

A small, mobile-first web app for showing a Hong Kong destination to a taxi driver. It searches OpenStreetMap data and presents the address in large Traditional Chinese with English and street details underneath.

## Features

- Hong Kong-focused search suggestions in Chinese or English
- Large bilingual taxi card with building name, street, house number, and district
- Full-screen card for handing the phone to a driver
- Favorites stored locally in the browser
- Shareable destination links that contain the address record
- Copy address text to the clipboard
- OpenStreetMap, Nominatim, and Overpass attribution and support links

## Run Locally

The app has no build step or backend.

For live reload while editing:

```bash
npx live-server --port=8001
```

Run the command from this directory, then open `http://localhost:8001`.

## Deploy

Deploy the files as a static site. Cloudflare Pages is a good fit:

1. Create a Pages project using Direct Upload or a Git repository.
2. Upload or deploy the project files without a build command.
3. Use `.` as the build output directory for a Git-connected Pages project.

Cloudflare Pages provides HTTPS automatically, which is needed for the native share sheet on most devices.

## Shared Links

The Share button creates a URL with a `d` query parameter, for example:

```text
https://example.pages.dev/?d=eyJuYW1lWmgiOiIuLi4ifQ
```

`d` is Base64URL-encoded UTF-8 JSON containing the current address record. The recipient can open the link without needing the sender's local favorites or an additional geocoding request.

## Data Services

This app uses:

- [OpenStreetMap](https://www.openstreetmap.org/) for map data
- [Nominatim](https://nominatim.openstreetmap.org/) for search
- [Overpass API](https://overpass-api.de/) to retrieve raw OSM address tags when Nominatim omits a street

The app throttles Nominatim calls to respect its public usage policy. Do not use the public endpoints for high-volume traffic; self-host or use a suitable commercial provider instead.

Support the services:

- [Donate to the OpenStreetMap Foundation](https://supporting.openstreetmap.org/)
- [Support Overpass API via FOSSGIS](https://www.fossgis.de/aktivit%C3%A4ten/langzeitf%C3%B6rderungen/overpass/)

## Contributing

Issues and pull requests are welcome. Keep changes dependency-free where possible, preserve the bilingual address display, and test searches using both English and Traditional Chinese names.

## License

A license file has not yet been added. Add an explicit open-source license before accepting external contributions or distributing modified copies.
