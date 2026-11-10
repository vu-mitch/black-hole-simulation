# Black Hole Flight Simulator

Fly a ship into a Schwarzschild black hole and, with a warp drive that suspends the physics, back out again. The view is ray-traced each frame: every pixel follows a light ray through the curved spacetime, so the gravitational lensing, the black shadow and the Doppler shift of the disk and the stars are computed rather than drawn on.

Distances are in Schwarzschild radii (rₛ = 1). The read-outs scale that to Sagittarius A*, the black hole at the centre of the Milky Way, where rₛ is 12.7 million km.

## Run

```bash
npm install
npm run dev
```

`npm test` checks the flight dynamics and the light bending against analytic results. `npm run build` type-checks and builds the static site.

## Flying

| Key | Action |
| --- | --- |
| W A S D, R F | Thrust forward, left, back, right, up, down |
| Shift | Full power |
| Drag, arrow keys | Look around |
| Q E | Roll |
| Mouse wheel | Zoom |
| Space | Warp drive: move anywhere, even back out of the horizon |
| T | Flight assist / free flight |
| L | Keep the nose pointed at the hole |
| 1–4 | Approach, orbit, photon sphere, free fall |
| [ ] | Slow down or speed up time |
| P | Pause |
| K, B, G, H | Disk, sky, quality, help |

On a touch screen, drag to look and use the two buttons to thrust.

Flight assist holds you still against gravity and flies at a set speed relative to hovering observers. Nothing can hover inside the horizon: every trajectory ends at the singularity, and the engines cannot prevent it. The warp drive is the one way out, and it is labelled as such because it is not physics.

## What is simulated

The ship moves in Gullstrand–Painlevé coordinates, which stay regular across the horizon, under its own proper acceleration. Light paths integrate the photon orbit equation u″ + u = 3⁄2 u². The accretion disk is a thin disk of gas on circular orbits from the innermost stable orbit outward, glowing as a black body and Doppler-shifted by its motion. Starlight is shifted by the gravitational and kinematic redshift of the ship.
