# Hydraulic Triangular Irregular Networks
GIS-inspired hydraulically-grounded Delaunay triangulation method for triangle meshes from heightfields. Includes a heavily optimized Delaunator (from d3.js) implementation.

Loosely based on ["Generation of Triangulated Irregular Networks Based on
Hydrological Similarity" by Vivoni et al (2004)](http://vivoni.asu.edu/pdf/VivoniJHE2004.pdf)

## Try it: [https://hydraulictrinetwork.netlify.app/](https://hydraulictrinetwork.netlify.app/)

## Build and run

Open the folder containing this code in your terminal.

`npm i -g tinybuild` (if not installed) 

then `tinybuild`

## Results

e.g. randomly generated erosion network from our [WebGPU erosion simulator](https://github.com/joshbrew/webgpu_hydraulic_thermal_erosion_Jako2011/blob/main/README.md):

<img width="400" height="400" alt="noise-main_export" src="https://github.com/user-attachments/assets/68cf364a-0af3-42f3-98ea-0bf5d205e6b4" />

With triangle mesh overlay (10px to 25px neighbor dist):

<img width="400" height="400" alt="image" src="https://github.com/user-attachments/assets/bb987d23-8771-4eb9-9f68-318a7f42ce69" />

Without raster to see stitching easier:

<img width="400" height="400" alt="image" src="https://github.com/user-attachments/assets/f0592d45-8fd1-47d4-a6f1-86293825a67c" />


Mostly an experiment, this lets you make simpler meshes while adhering better to flow direction. It takes 0.5-1s for an 800x800 raster to process a mesh. I could not do better than that.

### License

MIT
