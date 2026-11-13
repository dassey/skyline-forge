# Skyline Forge

Turn any US city, neighbourhood or address into a 3D-printable model, right in the browser. Search a place, pick a plate shape, choose layers and colours, add a route or your own data, and export 3MF, STL or OBJ.

Pick your printer and how many filaments you have, and the layers are grouped onto that many spools — keeping the contrast that matters, like a route against the streets under it. The preview shows the colours you will actually print, and the 3MF opens in Bambu Studio or OrcaSlicer with every part already on its filament and centred on your plate. The Print & export panel lists what to load in each slot, the grams of each filament, roughly how many colour changes the print makes, and whether it fits the plate.

Buildings are measured, not guessed, wherever the USGS has flown LiDAR: towers get their real heights and setbacks, houses their real ridge height and direction, and outlines that sit a few metres off are moved onto the building. See the in-app Guide for what a 2 m survey can and cannot tell you.

## Tests

```sh
npm test               # geometry, imports, filament planning, LiDAR roofs, then a live Overpass smoke test
npm run test:browser   # the whole app in headless Chromium
```

The browser test uses a cached OpenStreetMap extract when `npm run test:smoke` has saved one, and a synthetic city otherwise, so it also runs offline.

## Thanks

- [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors for the map data (ODbL)
- [Overpass API](https://overpass-api.de/) for serving it
- [Nominatim](https://nominatim.org/) and [Photon](https://photon.komoot.io/) by komoot for address search
- [USGS 3D Elevation Program](https://www.usgs.gov/3d-elevation-program) for the LiDAR that measures every roof, and [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/dataset/group/3dep-lidar) for serving it
- [Open-Meteo](https://open-meteo.com/) for elevation
- [Valhalla](https://github.com/valhalla/valhalla) and [OSRM](https://project-osrm.org/) for routing, hosted by [FOSSGIS](https://www.fossgis.de/)
- [USGS The National Map](https://www.usgs.gov/the-national-map) for basemap tiles
- [three.js](https://threejs.org/) for the 3D viewer
- [Leaflet](https://leafletjs.com/) for the map picker
- [earcut](https://github.com/mapbox/earcut), [polygon-clipping](https://github.com/mfogel/polygon-clipping) and [proj4js](https://github.com/proj4js/proj4js) for geometry
- [MgOpen](https://github.com/mrdoob/three.js/tree/dev/examples/fonts) Helvetiker font
- [Playwright](https://playwright.dev/) for testing

MIT licensed.
