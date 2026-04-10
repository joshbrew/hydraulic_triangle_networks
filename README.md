# Hydraulic Triangular Irregular Networks
GIS-inspired hydraulically-grounded Delaunay triangulation method for triangle meshes from heightfields.

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

With triangle mesh overlay:

<img width="400" height="400" alt="image" src="https://github.com/user-attachments/assets/f78293e3-5189-4f45-8a95-52f56f085d84" />

Without raster to see basin stitching:

<img width="400" height="400" alt="image" src="https://github.com/user-attachments/assets/78d4fb53-ba4a-422e-a0c2-f358be4d6724" />

Mostly an experiment, this lets you make simpler meshes while adhering better to flow direction. It takes 0.5-1s for an 800x800 raster to process a mesh. I could not do better than that.

### License

MIT
