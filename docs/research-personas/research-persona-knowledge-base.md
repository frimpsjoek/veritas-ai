# Research Persona Knowledge Base

```yaml
kb_name: research-persona-kb
version: 1.0
created: 2026-10-22
domains: [Materials Science, Chemistry, Physics, Biology, Computer Science, High-Performance Computing]
persona_count: 31
purpose: >
  Identify a researcher's persona from their query, surface the research areas of that persona,
  suggest precise directions to work on, and route them to the right methods, free tools, data and
  collaborators, so research is faster, organized and moves in a clear direction.
chunking: one chunk per H1 (domain overview) and per H2 (persona); never split inside a persona
```

---

# 0. How to Use This File

**What it is.** A structured catalogue of research personas. Each persona describes a type of researcher: what they work on, the questions they ask, the methods and free tools they use, the data they need, the directions they should consider next, and the signals that identify them in a query.

**How it is organized.**

1. Sections 0–4 are global: usage notes, schema, persona index, keyword routing map, cross-domain bridges.
2. Each domain starts with an H1 overview (`# Domain: ...`).
3. Each persona is one H2 chunk (`## <ID> · <Name>`) beginning with a fenced `yaml` metadata block, followed by fixed H3 sections in the same order every time.
4. Appendices hold the research-flow guide, the answer template the assistant should follow, and a template for adding new personas.

**Ingesting into a knowledge base (RAG).**

- Split on H1 and H2 headings. Each persona chunk is self-contained and safe to embed alone.
- Parse the `yaml` block into metadata fields (`persona_id`, `domain`, `keywords`, `adjacent_personas`) and use them as filters.
- Embed `keywords` + `Profile` + `Core research areas` together for the best retrieval of the persona.
- Keep `persona_id` stable; other chunks reference personas only by ID.

**Using it for training (fine-tuning / classifiers).**

- `Training examples` sections are ready question–answer pairs (instruction tuning).
- `Routing signals` give labelled trigger terms → use them to build a persona classifier (input: query, label: `persona_id`).
- `Suggested research directions` can become "suggest-next-step" training targets.

**Maintenance.** Review tool lists and directions every 6 months; fields such as LLMs, quantum computing and protein design change quickly. Add personas using Appendix C and register them in Sections 2 and 3.

---

# 1. Persona Schema

| Element | Type | Meaning |
|---|---|---|
| `persona_id` | string | Stable ID: `DOMAIN-NN` (MAT, CHEM, PHY, BIO, CS, HPC) |
| `name` | string | Persona name |
| `domain` | string | Parent domain |
| `subfield` | string | Narrower specialization |
| `aliases` | list | Other names researchers use for this area |
| `keywords` | list | Retrieval and routing terms |
| `adjacent_personas` | list | IDs of personas this one most often collaborates with |
| `compute_profile` | string | Typical computing needs (links to HPC personas) |
| `output_types` | list | What this persona typically produces |
| Profile | section | One-paragraph description |
| Core research areas | section | Main active research areas |
| Typical research questions | section | Questions this persona asks |
| Methods & techniques | section | Experimental, computational and analytical methods |
| Recommended tools (free) | section | One primary free tool per use case, with alternatives |
| Key data & resources | section | Databases, datasets, benchmarks, portals |
| Suggested research directions | section | Precise, ranked directions with a first step |
| Routing signals | section | When to route here; when to hand off |
| Training examples | section | Q&A pairs for training and evaluation |

---

# 2. Persona Index

| ID | Persona | Domain | One-line focus |
|---|---|---|---|
| MAT-01 | Computational Materials Scientist | Materials Science | DFT, MD and ML potentials for solids |
| MAT-02 | Energy Storage & Conversion Materials Researcher | Materials Science | Batteries, solid electrolytes, solar-cell materials |
| MAT-03 | Nanomaterials & 2D Materials Researcher | Materials Science | Graphene, TMDs, MXenes, nanoparticles |
| MAT-04 | Polymer & Soft Matter Scientist | Materials Science | Recyclable polymers, hydrogels, self-assembly |
| MAT-05 | Structural Materials & Metallurgy Engineer | Materials Science | Alloys, additive manufacturing, fatigue, corrosion |
| MAT-06 | Materials Informatics & Autonomous Lab Scientist | Materials Science | ML-driven discovery, self-driving labs |
| CHEM-01 | Synthetic Organic & Medicinal Chemist | Chemistry | New reactions, drug candidates, retrosynthesis |
| CHEM-02 | Computational & Theoretical Chemist | Chemistry | Quantum chemistry, mechanisms, free energies |
| CHEM-03 | Catalysis & Green Chemistry Researcher | Chemistry | CO2 conversion, green H2, sustainable processes |
| CHEM-04 | Analytical & Environmental Chemist | Chemistry | Mass spec, pollutants, sensors, chemometrics |
| CHEM-05 | Inorganic & Porous Materials Chemist | Chemistry | MOFs, COFs, coordination chemistry, crystallography |
| PHY-01 | Condensed Matter Physicist | Physics | Quantum materials, superconductivity, topology |
| PHY-02 | Quantum Information & Computing Researcher | Physics | Qubits, error correction, quantum algorithms |
| PHY-03 | Astrophysicist & Cosmologist | Physics | Exoplanets, gravitational waves, dark energy |
| PHY-04 | High-Energy & Nuclear Physicist | Physics | Colliders, neutrinos, dark matter, lattice QCD |
| PHY-05 | Optics & Photonics Researcher | Physics | Integrated photonics, metasurfaces, lasers |
| BIO-01 | Bioinformatician & Genomics Researcher | Biology | Sequencing, single-cell, population genomics |
| BIO-02 | Structural & Computational Biologist | Biology | Protein structure, design, biomolecular MD |
| BIO-03 | Molecular & Cell Biologist | Biology | CRISPR, organoids, signaling, imaging |
| BIO-04 | Microbiologist & Infectious Disease Researcher | Biology | AMR, pathogen genomics, microbiome |
| BIO-05 | Ecologist, Evolutionary & Agricultural Biologist | Biology | Crops, plant disease, biodiversity, climate |
| CS-01 | Machine Learning Researcher | Computer Science | Learning algorithms, UQ, ML for science |
| CS-02 | NLP & LLM Researcher | Computer Science | LLMs, agents, RAG, evaluation |
| CS-03 | Computer Vision Researcher | Computer Science | Detection, segmentation, VLMs, 3D |
| CS-04 | Systems, Distributed & Cloud Researcher | Computer Science | ML systems, edge, storage, networking |
| CS-05 | Security & Privacy Researcher | Computer Science | Privacy-preserving ML, IDS, LLM security |
| HPC-01 | HPC Systems & Infrastructure Engineer | HPC | Clusters, schedulers, storage, provisioning |
| HPC-02 | Parallel Programming & Performance Engineer | HPC | MPI, OpenMP, GPU, profiling, scaling |
| HPC-03 | AI-at-Scale Engineer | HPC | Distributed training and inference on clusters |
| HPC-04 | Research Software Engineer & Workflow Specialist | HPC | Software environments, containers, workflows, FAIR |
| HPC-05 | Research Computing Facilitator | HPC | Onboarding, portals, training, user support |

---

# 3. Routing Map (keyword → persona)

Use this table as the first-pass router. When several personas match, pick the one with the most matching keywords and list the others as collaborators.

| Query contains (any of) | Primary persona | Also consider |
|---|---|---|
| DFT, band gap calculation, formation energy, phonons, NEB, ab initio MD | MAT-01 | CHEM-02, PHY-01 |
| machine-learned interatomic potential, MACE, CHGNet, universal potential | MAT-01 | MAT-06, HPC-03 |
| battery, cathode, anode, solid electrolyte, sodium-ion, SEI, perovskite solar | MAT-02 | CHEM-03, MAT-01 |
| graphene, MoS2, TMD, MXene, quantum dots, nanoparticles, heterostructure | MAT-03 | PHY-01, PHY-05 |
| polymer, plastic recycling, hydrogel, rheology, coarse-grained, self-assembly | MAT-04 | CHEM-03 |
| alloy, steel, high-entropy alloy, additive manufacturing, fatigue, corrosion, CALPHAD | MAT-05 | MAT-01 |
| materials informatics, Bayesian optimization, self-driving lab, generative crystal | MAT-06 | CS-01, MAT-01 |
| synthesis route, retrosynthesis, total synthesis, photoredox, lead optimization, docking | CHEM-01 | BIO-02 |
| quantum chemistry, reaction mechanism, transition state, excited states, QM/MM | CHEM-02 | MAT-01, HPC-02 |
| catalyst, CO2 reduction, water splitting, green hydrogen, ammonia, life-cycle assessment | CHEM-03 | MAT-02, MAT-01 |
| mass spectrometry, metabolomics, PFAS, microplastics, heavy metals, chemometrics | CHEM-04 | BIO-04 |
| MOF, COF, coordination complex, crystal structure, gas adsorption, X-ray diffraction | CHEM-05 | MAT-06 |
| superconductivity, topological, moiré, strongly correlated, magnetism, spintronics | PHY-01 | MAT-03 |
| qubit, quantum error correction, Qiskit, quantum algorithm, QKD | PHY-02 | CHEM-02 |
| exoplanet, galaxy, cosmology, gravitational wave, telescope, JWST, radio astronomy | PHY-03 | CS-01, HPC-04 |
| LHC, particle physics, neutrino, dark matter detection, lattice QCD, nuclear | PHY-04 | HPC-02 |
| laser, photonics, metasurface, waveguide, FDTD, optical, ultrafast | PHY-05 | MAT-03 |
| genome, RNA-seq, single-cell, variant calling, GWAS, sequencing pipeline | BIO-01 | HPC-04 |
| protein structure, AlphaFold, protein design, cryo-EM, biomolecular MD | BIO-02 | CHEM-02, HPC-03 |
| CRISPR, cell culture, organoid, western blot, microscopy, signaling | BIO-03 | BIO-01 |
| antimicrobial resistance, pathogen, outbreak, microbiome, malaria, vaccine | BIO-04 | BIO-01 |
| crop, plant disease, biodiversity, ecology, species distribution, eDNA, climate impact | BIO-05 | CS-03 |
| deep learning, model training, uncertainty, GNN, reinforcement learning, federated | CS-01 | HPC-03 |
| LLM, chatbot, RAG, function calling, agents, fine-tuning, low-resource language | CS-02 | HPC-03 |
| object detection, segmentation, YOLO, image classification, vision transformer, 3D vision | CS-03 | CS-01 |
| Kubernetes, edge computing, IoT platform, serverless, distributed system | CS-04 | HPC-01 |
| intrusion detection, differential privacy, adversarial attack, malware, cryptography | CS-05 | CS-01 |
| Slurm, cluster setup, Lustre, Ceph, OpenHPC, provisioning, LDAP | HPC-01 | HPC-05 |
| MPI, OpenMP, CUDA, profiling, scaling, speedup, performance portability | HPC-02 | HPC-01 |
| multi-GPU, distributed training, FSDP, DeepSpeed, inference cluster | HPC-03 | CS-01 |
| Spack, modules, containers, Apptainer, Snakemake, reproducibility, research software | HPC-04 | BIO-01 |
| onboarding, Open OnDemand, HPC training, user support, allocation, documentation | HPC-05 | HPC-01 |

---

# 4. Cross-Domain Bridges

These are high-value themes where personas should be connected. When a query sits on a bridge, name the lead persona and the supporting ones.

| Research theme | Lead | Supporting | Why it matters |
|---|---|---|---|
| ML-accelerated materials discovery | MAT-06 | MAT-01, CS-01, HPC-03 | Cuts screening cost by orders of magnitude |
| Next-generation batteries | MAT-02 | MAT-01, CHEM-03, CHEM-04 | Energy transition and critical-mineral pressure |
| Green hydrogen and CO2 utilization | CHEM-03 | MAT-01, MAT-02, CHEM-02 | Decarbonizing industry |
| AI for drug discovery | CHEM-01 | BIO-02, CS-01, CHEM-02 | Faster hit-to-lead, lower failure rates |
| Protein design and enzyme engineering | BIO-02 | BIO-03, CHEM-01, HPC-03 | Therapeutics, biocatalysis, green chemistry |
| Genomic surveillance of pathogens | BIO-04 | BIO-01, HPC-04 | Outbreak response and AMR tracking |
| AI for agriculture and plant health | BIO-05 | CS-03, CS-04 | Food security, low-cost field diagnostics |
| Quantum materials for quantum computing | PHY-01 | PHY-02, MAT-03 | Better qubits and devices |
| Quantum computing for chemistry | PHY-02 | CHEM-02 | Early useful quantum advantage candidates |
| Scientific foundation models | CS-01 | CS-02, HPC-03, domain persona | Reusable models across science |
| LLM research assistants and support chatbots | CS-02 | HPC-05, HPC-04 | Faster literature work and user support |
| Privacy-preserving health and IoT analytics | CS-05 | CS-01, BIO-01 | Use sensitive data without exposing it |
| Exascale and energy-efficient simulation | HPC-02 | HPC-01, PHY-04, MAT-01 | More science per watt |
| Reproducible computational research | HPC-04 | all computational personas | Trustworthy, reusable results |
| Photonic hardware for AI | PHY-05 | CS-04, MAT-03 | Low-energy computing |
| Environmental monitoring with sensors and ML | CHEM-04 | CS-03, CS-04, BIO-05 | Water, air and soil quality at scale |


---

# Domain: Materials Science (MAT)

**Scope.** Discovery, design, processing, characterization and performance of materials, organized around the processing → structure → property → performance relationship.

**Grand challenges.** Materials for the energy transition; substitutes for scarce or critical elements; circular and low-carbon materials; materials for semiconductors and quantum technologies; shortening the discovery-to-deployment cycle from decades to years.

**Personas in this domain.** MAT-01 Computational Materials Scientist · MAT-02 Energy Storage & Conversion · MAT-03 Nanomaterials & 2D · MAT-04 Polymer & Soft Matter · MAT-05 Structural Materials & Metallurgy · MAT-06 Materials Informatics & Autonomous Labs.

**Typical compute.** CPU-heavy MPI jobs for DFT; GPUs for ML potentials and image analysis; large storage for microscopy and simulation trajectories.

---

## MAT-01 · Computational Materials Scientist

```yaml
persona_id: MAT-01
name: Computational Materials Scientist
domain: Materials Science
subfield: Atomistic and electronic-structure modeling
aliases: [computational materials science, atomistic modeling, first-principles materials, ab initio materials]
keywords: [DFT, molecular dynamics, ML interatomic potentials, phonons, band structure, defects, surfaces, interfaces, phase stability, NEB]
adjacent_personas: [CHEM-02, PHY-01, MAT-06, HPC-02]
compute_profile: CPU MPI jobs for DFT (tens to thousands of cores); GPUs for ML potentials and GPU-enabled codes; heavy scratch I/O
output_types: [predicted properties, stability and phase diagrams, mechanistic insight, screening shortlists, open datasets]
```

### Profile
Uses quantum-mechanical and atomistic simulation to predict, explain and screen the structure and properties of solids, often guiding or interpreting experiments.

### Core research areas
- Electronic structure of solids: band structures, density of states, band alignment
- Point defects, dopants and defect thermodynamics in semiconductors and oxides
- Surfaces, interfaces and grain boundaries
- Phase stability, convex hulls and finite-temperature thermodynamics (phonons, quasi-harmonic approximation)
- Machine-learned interatomic potentials (MLIPs) for large, long molecular dynamics
- Ionic transport and diffusion in electrolytes and membranes
- Mechanical and thermal properties from first principles

### Typical research questions
- Is this hypothetical compound thermodynamically stable and plausibly synthesizable?
- Which dopant improves conductivity without destabilizing the lattice?
- What limits ion diffusion across this interface?
- Can a universal ML potential replace DFT for my system, and with what error?

### Methods & techniques
- DFT with GGA, meta-GGA, hybrid functionals, DFT+U; GW for quantitative band gaps
- Ab initio and classical molecular dynamics; nudged elastic band (NEB) for barriers
- Phonons by finite displacement or DFPT; quasi-harmonic free energies
- Cluster expansion and Monte Carlo for disordered alloys
- Active learning to train MLIPs; uncertainty quantification on predictions

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Plane-wave DFT | Quantum ESPRESSO | ABINIT, CP2K, GPAW |
| Molecular dynamics | LAMMPS | GROMACS, OpenMM |
| ML interatomic potentials | MACE | NequIP/Allegro, CHGNet, MatGL (M3GNet) |
| Structures and workflows | pymatgen + atomate2 | ASE, AiiDA |
| Phonons | Phonopy | phono3py (thermal conductivity) |
| Visualization | OVITO (basic edition) | VESTA, VMD |

### Key data & resources
- Materials Project, OQMD, AFLOW, JARVIS-DFT, NOMAD, Alexandria
- OMat24 (large open DFT dataset for training MLIPs)
- Matbench and Matbench Discovery (benchmarks)

### Suggested research directions
1. **Fine-tune universal MLIPs on small targeted DFT sets.** Highest impact per compute hour. First step: measure zero-shot error of a universal model against 50–200 DFT calculations of your system.
2. **Defect and interface engineering for energy materials.** Links to MAT-02. First step: compute defect formation energies and charge-transition levels for the dominant dopants.
3. **Finite-temperature and disorder effects** (high-entropy, amorphous, partially occupied phases) where 0 K DFT is misleading.
4. **Uncertainty-aware screening pipelines** that tell experimentalists which predictions to trust.
5. **Validate generative crystal models for synthesizability.** Links to MAT-06.

### Routing signals
- **Route here when** the query mentions DFT, Quantum ESPRESSO/VASP, band gap calculation, formation energy, phonons, NEB, ab initio MD or ML potentials for solids.
- **Hand off** to CHEM-02 for molecules and gas-phase reactions; PHY-01 for many-body or topological theory; HPC-02 when the problem is scaling or performance.

### Training examples
**Q:** I want to study lithium diffusion in a new solid electrolyte but have limited compute. Where do I start?
**A:** Persona MAT-01 with MAT-02. Use a universal ML potential (e.g., MACE) for long MD runs at several temperatures, fit an Arrhenius plot for the activation energy, and validate key barriers with a few NEB calculations in Quantum ESPRESSO. Report the ML-vs-DFT error on your validation set.

**Q:** Why does my GGA calculation underestimate the band gap?
**A:** Semilocal functionals underestimate gaps due to self-interaction error and the missing derivative discontinuity. Use a hybrid functional such as HSE06, DFT+U for localized d/f states, or GW for quantitative values, and compare with measured optical gaps.

---

## MAT-02 · Energy Storage & Conversion Materials Researcher

```yaml
persona_id: MAT-02
name: Energy Storage & Conversion Materials Researcher
domain: Materials Science
subfield: Batteries, electrolytes, photovoltaic and electrochemical energy materials
aliases: [battery materials, energy materials, electrochemical energy storage, solar cell materials]
keywords: [lithium-ion, sodium-ion, solid-state battery, cathode, anode, electrolyte, SEI, degradation, perovskite solar cell, supercapacitor]
adjacent_personas: [MAT-01, CHEM-03, CHEM-04, MAT-06]
compute_profile: Mostly workstation-scale data analysis; DFT/MD via MAT-01; GPUs for battery-lifetime ML
output_types: [new electrode/electrolyte materials, cell performance data, degradation models, lifetime predictions]
```

### Profile
Designs, synthesizes and tests materials that store or convert energy, and studies why devices degrade.

### Core research areas
- Solid-state electrolytes (sulfides, oxides, halides, polymers) and lithium-metal anodes
- Sodium-ion and other post-lithium chemistries using abundant elements
- Cathodes: nickel-rich layered oxides, LFP/LMFP, manganese-rich and cobalt-free designs
- Electrode–electrolyte interphases (SEI/CEI) and dendrite suppression
- Battery degradation, state-of-health estimation and lifetime prediction with ML
- Perovskite and tandem solar cells: stability and lead-free compositions
- Supercapacitors and hybrid devices

### Typical research questions
- Which electrolyte composition gives high ionic conductivity and a stable interface with lithium metal?
- What dominates capacity fade in this cathode after 500 cycles?
- Can early-cycle data predict cell lifetime?
- How can perovskite solar cells survive heat and humidity?

### Methods & techniques
- Galvanostatic cycling, cyclic voltammetry, electrochemical impedance spectroscopy (EIS), GITT
- XRD, SEM/TEM, XPS, operando and in situ characterization
- Physics-based cell models (single particle, Doyle–Fuller–Newman)
- ML on cycling data; equivalent-circuit fitting of EIS

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Battery cell modeling | PyBaMM | BattMo |
| EIS fitting | impedance.py | DRTtools |
| Cycling data analysis | pandas + Python (Jupyter) | R |
| XRD refinement | GSAS-II | FullProf |
| Atomistic insight | via MAT-01 tools (Quantum ESPRESSO, MACE) | — |

### Key data & resources
- Battery Archive (batteryarchive.org), CALCE battery datasets, NASA PCoE battery data
- Severson et al. fast-charging cycle-life dataset
- Materials Project battery explorer

### Suggested research directions
1. **Interface engineering for solid-state batteries.** The interface, not bulk conductivity, now limits most cells. First step: pair EIS over cycling with post-mortem XPS.
2. **Sodium-ion cathodes and hard-carbon anodes** from abundant or locally available precursors.
3. **Early-life lifetime prediction** with physics-informed ML. Links to CS-01. First step: reproduce a baseline on a public cycling dataset.
4. **Second-life and recycling-aware materials design** (direct cathode recycling).
5. **Perovskite stability** through compositional and interface passivation.

### Routing signals
- **Route here when** the query mentions battery, cathode, anode, electrolyte, cycling, capacity fade, SEI, sodium-ion, perovskite solar cell or supercapacitor.
- **Hand off** to MAT-01 for DFT/MD of ion transport; CHEM-03 for electrocatalysis and hydrogen; CHEM-04 for electrolyte decomposition analysis.

### Training examples
**Q:** My NMC cathode loses 20% capacity in 200 cycles. How do I find the cause?
**A:** Persona MAT-02. Separate loss mechanisms with differential capacity (dQ/dV) analysis and EIS over cycling, then do post-mortem XRD (structural change), SEM (particle cracking) and XPS (surface reconstruction and CEI). Compare with a reference electrolyte to separate cathode from electrolyte effects.

**Q:** Is there a free tool for simulating a lithium-ion cell?
**A:** PyBaMM is the primary free option; it implements SPM, SPMe and DFN models with parameter sets for common chemistries. BattMo is an alternative.

---

## MAT-03 · Nanomaterials & 2D Materials Researcher

```yaml
persona_id: MAT-03
name: Nanomaterials & 2D Materials Researcher
domain: Materials Science
subfield: Low-dimensional materials and nanoscale synthesis
aliases: [nanotechnology, 2D materials, nanoscience, low-dimensional materials]
keywords: [graphene, TMD, MoS2, hBN, MXene, quantum dots, nanoparticles, heterostructure, CVD growth, Raman, TEM, AFM]
adjacent_personas: [PHY-01, PHY-05, MAT-01, CHEM-05]
compute_profile: Workstation image and spectra analysis; GPUs for microscopy ML; DFT via MAT-01
output_types: [synthesis protocols, nanoscale devices, characterization datasets, sensors]
```

### Profile
Synthesizes and characterizes materials whose properties come from nanoscale size or atomic thinness, and builds devices from them.

### Core research areas
- Graphene, transition-metal dichalcogenides (TMDs), hexagonal boron nitride, MXenes
- Van der Waals heterostructures and twisted (moiré) stacks
- Scalable growth: CVD, MOCVD, liquid-phase exfoliation
- Quantum dots and plasmonic nanoparticles
- Nanomaterials for sensing, catalysis, membranes and electronics
- Nanomaterial safety and environmental fate

### Typical research questions
- How do I grow wafer-scale monolayers with low defect density?
- How do defects or strain change optical and electronic properties?
- Can this nanomaterial make a cheaper, more sensitive sensor?

### Methods & techniques
- CVD, hydrothermal and colloidal synthesis, exfoliation
- Raman and photoluminescence spectroscopy, AFM, SEM, TEM/STEM, XPS
- Device fabrication: lithography, transfer, electrical transport measurements
- Tight-binding and DFT modeling (with MAT-01 / PHY-01)

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| AFM/SPM image analysis | Gwyddion | ImageJ/Fiji |
| Spectra fitting (Raman, PL) | lmfit (Python) | Fityk |
| Electron microscopy analysis | HyperSpy | py4DSTEM |
| Quantum transport simulation | Kwant | pybinding |
| General image analysis | Fiji | napari |

### Key data & resources
- C2DB (Computational 2D Materials Database), 2DMatPedia, JARVIS-2D
- Materials Project for bulk parent structures

### Suggested research directions
1. **Defect-controlled scalable growth** of TMDs for electronics. First step: correlate growth parameters with Raman/PL defect markers.
2. **MXenes for energy storage, EMI shielding and water treatment.** Focus on oxidation stability.
3. **Low-cost 2D-material sensors** (gas, humidity, biosensing) with ML readout. Links to CS-01.
4. **Automated microscopy analysis** with ML (flake detection, defect counting). Links to CS-03.
5. **Environmental and health safety** of nanomaterials across their life cycle.

### Routing signals
- **Route here when** the query mentions graphene, MoS2, TMD, MXene, nanoparticles, quantum dots, exfoliation, CVD growth or nanoscale characterization.
- **Hand off** to PHY-01 for correlated or topological physics in moiré systems; PHY-05 for nanophotonics; CHEM-05 for porous framework chemistry.

### Training examples
**Q:** How do I tell monolayer from bilayer MoS2 quickly?
**A:** Persona MAT-03. Use Raman: the separation between the E2g and A1g peaks is about 18–19 cm⁻¹ for a monolayer and grows with layer number; monolayers also show strong photoluminescence near 1.8–1.9 eV. Confirm thickness with AFM (analyze in Gwyddion).

**Q:** I have hundreds of optical microscope images of exfoliated flakes. Can I automate finding monolayers?
**A:** Yes: combine contrast-based thresholding with a small segmentation model (e.g., a U-Net or Cellpose-style model fine-tuned on labelled flakes). Annotate 100–200 images in CVAT, train, and validate against Raman-confirmed samples. Involve CS-03.

---

## MAT-04 · Polymer & Soft Matter Scientist

```yaml
persona_id: MAT-04
name: Polymer & Soft Matter Scientist
domain: Materials Science
subfield: Polymers, colloids, gels and self-assembled materials
aliases: [polymer science, soft matter, macromolecular science, polymer engineering]
keywords: [polymer, plastic recycling, biodegradable, hydrogel, rheology, self-assembly, coarse-grained simulation, polymer electrolyte, composites]
adjacent_personas: [CHEM-03, MAT-01, MAT-06, BIO-03]
compute_profile: GPU-friendly coarse-grained MD; workstation for rheology and DSC data
output_types: [new polymers, recycling processes, structure-property relations, biomaterials]
```

### Profile
Studies the synthesis, structure, dynamics and properties of polymers and soft materials, increasingly with a focus on sustainability and circularity.

### Core research areas
- Chemical and mechanical recycling; depolymerization and upcycling
- Bio-based and biodegradable polymers (PLA, PHA, cellulose, chitosan)
- Hydrogels for tissue engineering, drug delivery and agriculture
- Polymer electrolytes and membranes
- Self-assembly of block copolymers, colloids and liquid crystals
- Polymer informatics and property prediction

### Typical research questions
- Can this plastic be depolymerized back to monomer economically?
- How do crosslink density and water content control hydrogel stiffness?
- Which bio-based polymer can replace this packaging film?

### Methods & techniques
- Polymerization (step-growth, RAFT, ATRP, ring-opening)
- GPC/SEC, DSC, TGA, rheology, tensile testing, SAXS/SANS
- All-atom and coarse-grained MD (e.g., MARTINI)
- Life-cycle assessment for sustainability claims

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Molecular / coarse-grained MD | GROMACS (with MARTINI) | LAMMPS, HOOMD-blue |
| Polymer representation and descriptors | RDKit | Mordred |
| Scattering data reduction | SasView | — |
| Life-cycle assessment | openLCA | Brightway |
| Data analysis | Python (pandas, SciPy) | R |

### Key data & resources
- PoLyInfo (NIMS, free registration), PI1M (generated polymer set), CRIPT
- PubChem for monomers

### Suggested research directions
1. **Closed-loop chemically recyclable polymers** designed for depolymerization. Links to CHEM-03.
2. **Agricultural hydrogels and biodegradable films** from local biomass (cassava starch, cellulose, chitosan).
3. **Polymer informatics** to predict glass transition and degradation rate. Links to MAT-06.
4. **Solid polymer electrolytes** for safer batteries. Links to MAT-02.
5. **Microplastic generation and degradation pathways.** Links to CHEM-04.

### Routing signals
- **Route here when** the query mentions polymer, plastic, recycling, hydrogel, rheology, glass transition, block copolymer or coarse-grained simulation.
- **Hand off** to CHEM-03 for catalytic depolymerization; BIO-03 for cell response to biomaterials; CHEM-04 for microplastic detection.

### Training examples
**Q:** How do I make a hydrogel with tunable stiffness for cell culture?
**A:** Persona MAT-04 with BIO-03. Vary crosslinker concentration in a PEG or gelatin-methacrylate (GelMA) system, measure storage modulus by rheology, and map modulus vs. crosslinker in a calibration curve. Check swelling and cytocompatibility before cell work.

**Q:** Can I simulate polymer self-assembly without a supercomputer?
**A:** Yes. Coarse-grained MD with the MARTINI force field in GROMACS runs microsecond-scale simulations on a single GPU, which is usually enough to see micelle or vesicle formation.

---

## MAT-05 · Structural Materials & Metallurgy Engineer

```yaml
persona_id: MAT-05
name: Structural Materials & Metallurgy Engineer
domain: Materials Science
subfield: Metals, alloys, ceramics and composites for load-bearing use
aliases: [metallurgy, physical metallurgy, structural materials, mechanical behavior of materials]
keywords: [alloy, steel, high-entropy alloy, additive manufacturing, 3D printing metals, fatigue, fracture, corrosion, microstructure, CALPHAD, phase-field, EBSD]
adjacent_personas: [MAT-01, MAT-06, HPC-02, CHEM-04]
compute_profile: CPU finite-element and phase-field simulations; GPU for microstructure image ML
output_types: [alloy compositions, processing windows, failure analyses, mechanical property data]
```

### Profile
Develops and qualifies metals, alloys, ceramics and composites for structural use, linking processing to microstructure to mechanical performance.

### Core research areas
- High-entropy and complex concentrated alloys
- Metal additive manufacturing: defects, residual stress, process–microstructure links
- Fatigue, fracture and creep; damage tolerance
- Corrosion and protective coatings
- Lightweight alloys (Al, Mg, Ti) and low-carbon (green) steel production
- Ceramics and composites for extreme environments

### Typical research questions
- Which composition gives high strength with acceptable ductility?
- What process parameters remove porosity in laser powder-bed fusion?
- Why did this component fail, and how can it be prevented?

### Methods & techniques
- Optical/SEM metallography, EBSD, XRD, hardness and tensile/fatigue testing
- CALPHAD thermodynamics; phase-field microstructure modeling
- Finite-element analysis; crystal plasticity
- Fractography and failure analysis

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| CALPHAD thermodynamics | pycalphad | OpenCalphad |
| Phase-field simulation | MOOSE | PRISMS-PF, FiPy |
| Finite-element mechanics | CalculiX | Code_Aster, FEniCSx |
| Crystal plasticity | DAMASK | — |
| Microstructure analysis | DREAM.3D | Fiji |

### Key data & resources
- NIST materials data repositories, MatWeb (free tier)
- Published multi-principal-element alloy datasets
- Materials Project and OQMD for phase stability inputs

### Suggested research directions
1. **ML-guided alloy design** combining CALPHAD and small experimental sets. Links to MAT-06.
2. **In-process monitoring of metal AM** with sensor data and ML defect detection. Links to CS-03.
3. **Corrosion in tropical and marine environments** for infrastructure and mining equipment.
4. **Low-carbon steelmaking and scrap-based metallurgy** (impurity tolerance).
5. **Digital twins of components** for fatigue-life prediction. Links to HPC-02.

### Routing signals
- **Route here when** the query mentions alloy, steel, metal 3D printing, fatigue, fracture, corrosion, EBSD, CALPHAD or microstructure.
- **Hand off** to MAT-01 for atomistic mechanisms; CHEM-04 for corrosion product analysis; HPC-02 for large FEM runs.

### Training examples
**Q:** How do I predict which phases form in my high-entropy alloy before casting?
**A:** Persona MAT-05. Run CALPHAD equilibrium and Scheil solidification calculations in pycalphad with an appropriate thermodynamic database, check against empirical rules (mixing enthalpy, atomic size mismatch, valence electron concentration), then confirm with XRD and SEM on as-cast samples.

**Q:** My printed titanium parts crack in fatigue tests. What should I check first?
**A:** Examine fracture surfaces for initiation at porosity or lack-of-fusion defects, measure porosity by CT or metallography, and check surface roughness. Hot isostatic pressing and surface machining often improve fatigue life significantly.

---

## MAT-06 · Materials Informatics & Autonomous Lab Scientist

```yaml
persona_id: MAT-06
name: Materials Informatics & Autonomous Lab Scientist
domain: Materials Science
subfield: Data-driven and AI-accelerated materials discovery
aliases: [materials informatics, AI for materials, self-driving labs, accelerated materials discovery]
keywords: [machine learning, graph neural network, Bayesian optimization, active learning, generative design, self-driving lab, text mining, FAIR data]
adjacent_personas: [MAT-01, CS-01, CS-02, HPC-03]
compute_profile: GPUs for training GNNs and generative models; moderate CPU for featurization; databases
output_types: [predictive models, candidate shortlists, automated workflows, curated datasets]
```

### Profile
Combines materials science with machine learning, automation and data infrastructure to discover materials faster than trial and error.

### Core research areas
- Property prediction with graph neural networks and descriptors
- Generative models for crystals and molecules
- Bayesian optimization and active learning for experiments
- Self-driving (autonomous) laboratories
- LLMs and text mining for extracting synthesis knowledge from papers
- FAIR materials data infrastructure

### Typical research questions
- Which 20 candidates from 100,000 should we synthesize first?
- How do I optimize a recipe with as few experiments as possible?
- How reliable are model predictions outside the training distribution?

### Methods & techniques
- Featurization (composition, structure), GNNs, gradient boosting
- Gaussian processes and Bayesian optimization
- Diffusion and other generative models for structures
- NLP pipelines for literature extraction
- Uncertainty quantification and out-of-distribution testing

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Featurization | matminer | DScribe |
| Graph neural networks | MatGL | ALIGNN, CGCNN |
| Bayesian optimization | BoTorch (via Ax) | scikit-optimize |
| Literature extraction | ChemDataExtractor | LLM-based extraction with open models |
| Free GPU compute | Kaggle Notebooks | Google Colab |

### Key data & resources
- Materials Project, OQMD, JARVIS, Alexandria, OMat24
- Matbench and Matbench Discovery benchmarks
- Open-access literature corpora for text mining

### Suggested research directions
1. **Closed-loop Bayesian optimization** for one real synthesis problem; even a semi-automated loop produces publishable results. First step: define objective, parameters and budget.
2. **Uncertainty-calibrated screening** and honest out-of-distribution evaluation.
3. **LLM agents that plan simulations or experiments** with tool calling. Links to CS-02.
4. **Synthesizability prediction** to filter generative-model output.
5. **Small-data learning** (transfer learning, physics-informed priors) for experimental datasets.

### Routing signals
- **Route here when** the query mentions ML for materials, property prediction, Bayesian optimization of experiments, self-driving lab, generative materials design or materials databases.
- **Hand off** to MAT-01 for generating DFT training data; CS-01 for core ML methods; HPC-03 for scaling training.

### Training examples
**Q:** I can only afford 30 experiments to optimize a coating formulation with five ingredients. What should I do?
**A:** Persona MAT-06. Use Bayesian optimization: start with about 10 space-filling experiments (Latin hypercube), fit a Gaussian process, and pick the next batches with an acquisition function such as expected improvement in Ax/BoTorch. Track model uncertainty and stop when improvement plateaus.

**Q:** My GNN predicts formation energy well on test data but fails on new chemistries. Why?
**A:** A random split leaks similar compositions into the test set. Evaluate with leave-cluster-out or chemistry-held-out splits, report uncertainty, and add targeted DFT data for the new chemical space (with MAT-01).

---

# Domain: Chemistry (CHEM)

**Scope.** Composition, structure, reactivity and transformation of matter at the molecular level: making molecules, understanding reactions, measuring substances and designing functional compounds.

**Grand challenges.** Sustainable chemical manufacturing; decarbonizing fuels and feedstocks; faster, cheaper drug discovery; detecting and removing emerging pollutants; carbon capture and clean water.

**Personas in this domain.** CHEM-01 Synthetic Organic & Medicinal · CHEM-02 Computational & Theoretical · CHEM-03 Catalysis & Green Chemistry · CHEM-04 Analytical & Environmental · CHEM-05 Inorganic & Porous Materials.

**Typical compute.** Quantum chemistry is CPU and memory heavy; docking and ML screening are GPU-friendly; analytical data needs workstation-scale processing and storage.

---

## CHEM-01 · Synthetic Organic & Medicinal Chemist

```yaml
persona_id: CHEM-01
name: Synthetic Organic & Medicinal Chemist
domain: Chemistry
subfield: Organic synthesis, methodology and drug discovery
aliases: [organic chemistry, medicinal chemistry, drug discovery chemistry, synthetic methodology]
keywords: [synthesis, retrosynthesis, photoredox, electrosynthesis, asymmetric catalysis, flow chemistry, lead optimization, SAR, docking, natural products]
adjacent_personas: [CHEM-02, BIO-02, BIO-03, CHEM-03]
compute_profile: Workstation cheminformatics; GPUs for docking and ML screening
output_types: [new reactions, target molecules, structure-activity relationships, drug candidates]
```

### Profile
Designs and makes organic molecules, develops new reactions, and optimizes compounds for biological activity.

### Core research areas
- Photoredox and electrochemical synthesis
- C–H functionalization and late-stage functionalization
- Asymmetric and biocatalytic synthesis
- Flow chemistry and automated synthesis
- AI-assisted retrosynthesis and reaction-condition prediction
- Drug discovery: hit-to-lead, covalent inhibitors, PROTACs and molecular glues
- Bioactive natural products and medicinal plants

### Typical research questions
- What is the shortest, cheapest route to this target?
- Which analogues improve potency without hurting solubility or toxicity?
- Can this step be made greener (solvent, catalyst, energy)?

### Methods & techniques
- Reaction screening and optimization (including design of experiments)
- NMR, LC-MS, IR, X-ray crystallography for characterization
- Structure–activity relationship (SAR) analysis
- Docking and virtual screening; ADMET prediction

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Cheminformatics | RDKit | Open Babel, CDK |
| Retrosynthesis planning | AiZynthFinder | ASKCOS |
| Molecular docking | AutoDock Vina | smina, gnina |
| NMR processing | NMRium | — |
| Molecule drawing | Ketcher | ChemSketch (freeware) |

### Key data & resources
- PubChem, ChEMBL, ZINC, Open Reaction Database (ORD), USPTO reaction data
- PDB for target structures (with BIO-02)

### Suggested research directions
1. **Photo- and electrochemical methods** that replace stoichiometric reagents. Low equipment cost, high novelty.
2. **AI-guided reaction optimization** with Bayesian optimization. Links to MAT-06.
3. **Bioactive compounds from medicinal plants** with modern dereplication (LC-MS/MS + GNPS). Links to CHEM-04.
4. **Targets for neglected tropical diseases and malaria** using open drug-discovery datasets.
5. **Covalent and degrader modalities** for difficult targets.

### Routing signals
- **Route here when** the query mentions synthesis route, reaction conditions, yields, retrosynthesis, medicinal chemistry, SAR, docking or natural products.
- **Hand off** to CHEM-02 for mechanisms; BIO-02 for protein targets and structure; BIO-03 for biological assays.

### Training examples
**Q:** I isolated a compound from a medicinal plant extract. How do I know it is new?
**A:** Persona CHEM-01 with CHEM-04. Acquire HRMS and MS/MS data and run molecular networking on GNPS to dereplicate against spectral libraries, then search the formula and substructure in PubChem. Confirm structure by 1D/2D NMR and, if crystals form, X-ray crystallography.

**Q:** Is there a free retrosynthesis tool?
**A:** AiZynthFinder is open source and works with stock compound lists; ASKCOS is an alternative. Treat proposed routes as suggestions and check each step against the literature.

---

## CHEM-02 · Computational & Theoretical Chemist

```yaml
persona_id: CHEM-02
name: Computational & Theoretical Chemist
domain: Chemistry
subfield: Quantum chemistry, molecular simulation and chemical ML
aliases: [quantum chemistry, theoretical chemistry, molecular modeling, computational chemistry]
keywords: [DFT, coupled cluster, reaction mechanism, transition state, excited states, TD-DFT, QM/MM, free energy, conformers, ML potentials for molecules]
adjacent_personas: [MAT-01, CHEM-01, BIO-02, PHY-02, HPC-02]
compute_profile: CPU and high-memory nodes for wavefunction methods; GPUs for ML potentials and MD
output_types: [mechanisms, energies and spectra, predicted properties, benchmark datasets]
```

### Profile
Uses quantum mechanics, simulation and ML to explain and predict molecular structure, reactivity and spectroscopy.

### Core research areas
- Reaction mechanisms and transition states
- Excited states and photochemistry
- Solvation, QM/MM and enzyme mechanisms
- Free-energy calculations for binding and reactions
- ML potentials and models trained on quantum-chemistry data
- Spectroscopy prediction (IR, NMR, UV-Vis)
- Quantum computing algorithms for chemistry (with PHY-02)

### Typical research questions
- What is the rate-limiting step and how can it be lowered?
- Which conformer dominates in solution?
- Why does this molecule absorb at this wavelength?

### Methods & techniques
- DFT, coupled cluster (DLPNO-CCSD(T)), semi-empirical tight binding (GFN2-xTB)
- TD-DFT and multireference methods
- Conformer searching, implicit/explicit solvation, QM/MM
- Alchemical free-energy methods; enhanced sampling

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Quantum chemistry | Psi4 | PySCF, NWChem, ORCA (free for academics) |
| Fast semi-empirical | xtb | MOPAC |
| Conformer search | CREST | RDKit ETKDG |
| MD and free energy | OpenMM | GROMACS |
| Visualization | Avogadro | Jmol, VMD |

### Key data & resources
- QM9, ANI-1x, SPICE, OMol25 (large open molecular DFT dataset)
- NIST Computational Chemistry Comparison and Benchmark Database (CCCBDB)

### Suggested research directions
1. **ML potentials for reactive chemistry and solvation** using open datasets like OMol25.
2. **Mechanism-guided catalyst design** with experimental groups (CHEM-03).
3. **Spectra prediction to support identification** of unknowns. Links to CHEM-04.
4. **Benchmarking quantum algorithms on small molecules** with PHY-02.
5. **Cheap-to-accurate workflows**: xtb screening → DFT refinement → coupled-cluster checks.

### Routing signals
- **Route here when** the query mentions reaction mechanism, transition state, quantum chemistry, TD-DFT, conformers, QM/MM or computed spectra.
- **Hand off** to MAT-01 for periodic solids; BIO-02 for large biomolecules; HPC-02 for performance tuning.

### Training examples
**Q:** Which DFT functional should I use for organic reaction barriers?
**A:** Persona CHEM-02. Start with a dispersion-corrected hybrid or range-separated functional (e.g., ωB97X-D or B3LYP-D3 with a triple-zeta basis), include solvation, and check key barriers with DLPNO-CCSD(T) single points. Report how sensitive conclusions are to functional choice.

**Q:** I have 500 molecules and need conformers and rough energies fast.
**A:** Generate conformers with CREST (or RDKit ETKDG), optimize with GFN2-xTB, then re-rank the lowest few per molecule with DFT. This keeps cost manageable on a modest cluster.

---

## CHEM-03 · Catalysis & Green Chemistry Researcher

```yaml
persona_id: CHEM-03
name: Catalysis & Green Chemistry Researcher
domain: Chemistry
subfield: Heterogeneous, homogeneous and electrocatalysis; sustainable processes
aliases: [catalysis, green chemistry, sustainable chemistry, electrocatalysis]
keywords: [catalyst, CO2 reduction, water splitting, green hydrogen, OER, HER, ammonia, biomass valorization, plastic upcycling, single-atom catalyst, life-cycle assessment]
adjacent_personas: [MAT-01, MAT-02, CHEM-02, MAT-04]
compute_profile: DFT for adsorption energies (via MAT-01/CHEM-02); workstation kinetics and LCA
output_types: [catalysts, reaction pathways, process designs, sustainability assessments]
```

### Profile
Develops catalysts and processes that make chemicals and fuels with less energy, waste and carbon.

### Core research areas
- Electrocatalytic CO2 and nitrogen reduction
- Water electrolysis: OER/HER catalysts from earth-abundant elements
- Single-atom and alloy catalysts
- Biomass conversion to fuels and chemicals
- Catalytic plastic recycling and upcycling
- Green solvents and process intensification
- Life-cycle and techno-economic assessment

### Typical research questions
- Which catalyst gives the best activity–stability–cost balance?
- What descriptor (e.g., adsorption energy) predicts activity?
- Is the process actually greener than the incumbent?

### Methods & techniques
- Catalyst synthesis, BET surface area, XRD, XPS, TEM, chemisorption
- Electrochemical testing (polarization curves, Tafel analysis, stability tests)
- Microkinetic modeling and DFT descriptors
- LCA and techno-economic analysis

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Microkinetic modeling | CatMAP | Cantera |
| Adsorption-energy DFT | Quantum ESPRESSO via ASE | GPAW |
| ML catalyst screening | Open Catalyst (fairchem) models | MACE |
| Life-cycle assessment | openLCA | Brightway |
| Data analysis | Python (pandas, SciPy) | R |

### Key data & resources
- Open Catalyst datasets (OC20, OC22), Catalysis-Hub
- NIST Chemistry WebBook for thermochemistry

### Suggested research directions
1. **Earth-abundant OER/HER catalysts** with long-duration stability tests (not just initial activity).
2. **Biomass waste valorization** (agricultural residues) to platform chemicals.
3. **ML-accelerated catalyst screening** with pretrained Open Catalyst models, then targeted DFT. Links to MAT-06.
4. **Plastic upcycling** via catalytic hydrogenolysis or pyrolysis. Links to MAT-04.
5. **LCA from day one** so green claims are defensible.

### Routing signals
- **Route here when** the query mentions catalyst, catalytic activity, CO2 conversion, hydrogen production, electrolysis, biomass, upcycling or green chemistry metrics.
- **Hand off** to MAT-01 for surface DFT; MAT-02 for battery electrochemistry; CHEM-04 for product quantification.

### Training examples
**Q:** How do I report OER catalyst performance properly?
**A:** Persona CHEM-03. Report overpotential at 10 mA cm⁻² normalized to geometric area and to electrochemically active surface area, Tafel slope, Faradaic efficiency, and stability for at least 24–100 hours. Correct for iR drop and state electrolyte purity, since iron impurities in KOH can inflate activity.

**Q:** Can I screen catalysts computationally without much DFT?
**A:** Use pretrained Open Catalyst graph models to estimate adsorption energies for many surfaces, rank candidates by known activity descriptors, and run DFT only on the top few for confirmation.

---

## CHEM-04 · Analytical & Environmental Chemist

```yaml
persona_id: CHEM-04
name: Analytical & Environmental Chemist
domain: Chemistry
subfield: Measurement science, environmental monitoring, chemometrics
aliases: [analytical chemistry, environmental chemistry, measurement science, chemometrics]
keywords: [mass spectrometry, LC-MS, GC-MS, metabolomics, non-target screening, PFAS, microplastics, heavy metals, water quality, sensors, chemometrics, ICP-MS]
adjacent_personas: [BIO-04, CHEM-01, MAT-03, CS-01]
compute_profile: Workstation processing of large MS files; moderate storage; occasional ML
output_types: [validated methods, environmental datasets, exposure assessments, sensors]
```

### Profile
Develops methods to identify and quantify chemicals, and applies them to the environment, food and health.

### Core research areas
- High-resolution mass spectrometry and non-target screening
- Emerging contaminants: PFAS, pharmaceuticals, pesticides, microplastics
- Heavy metals from mining and industry in water, soil and food
- Low-cost and portable sensors
- Metabolomics and exposomics
- Chemometrics and ML on spectra
- Atmospheric chemistry and air quality

### Typical research questions
- What unknown contaminants are in this water source?
- Is this method accurate and precise enough for regulatory use?
- Can a cheap sensor match a lab instrument?

### Methods & techniques
- LC-MS/MS, GC-MS, ICP-MS/OES, AAS, FTIR/Raman, UV-Vis
- Method validation (LOD, LOQ, linearity, recovery, matrix effects)
- Multivariate analysis (PCA, PLS), ML classification of spectra
- Sampling design and QA/QC

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| LC-MS data processing | MZmine | MS-DIAL, OpenMS, XCMS |
| Molecular networking | GNPS (web) | — |
| Chemometrics | scikit-learn | R (mdatools) |
| Spatial mapping of samples | QGIS | — |
| Statistics | R | Python (statsmodels) |

### Key data & resources
- MassBank, GNPS libraries, HMDB, NIST Chemistry WebBook
- US EPA CompTox Chemicals Dashboard

### Suggested research directions
1. **Heavy-metal and mercury contamination around mining sites** with spatial mapping and risk assessment.
2. **Non-target screening of drinking-water sources** with open libraries.
3. **Low-cost sensors calibrated with ML** against reference instruments. Links to MAT-03, CS-01.
4. **Microplastic occurrence** in rivers and food chains with standardized protocols.
5. **Open, FAIR environmental datasets** for regional baselines.

### Routing signals
- **Route here when** the query mentions mass spectrometry, quantification, contaminant, water/soil/air quality, method validation, sensors or chemometrics.
- **Hand off** to BIO-04 for microbial contamination; CHEM-01 for structure elucidation; MAT-03 for sensor materials.

### Training examples
**Q:** How do I validate an ICP-MS method for lead in drinking water?
**A:** Persona CHEM-04. Determine LOD/LOQ from blanks, build a calibration curve with an internal standard, test linearity, check accuracy with a certified reference material and spike recoveries (typically 80–120%), and report repeatability and reproducibility. Include field and procedural blanks.

**Q:** I have hundreds of LC-MS files from river samples. How do I find what is in them?
**A:** Process with MZmine for feature detection and alignment, export to GNPS for molecular networking and library matching, then prioritize features by intensity and frequency. Confirm top hits with standards.

---

## CHEM-05 · Inorganic & Porous Materials Chemist

```yaml
persona_id: CHEM-05
name: Inorganic & Porous Materials Chemist
domain: Chemistry
subfield: Coordination chemistry, MOFs/COFs, crystallography
aliases: [inorganic chemistry, coordination chemistry, MOF chemistry, reticular chemistry]
keywords: [MOF, COF, coordination complex, ligand, crystal structure, X-ray diffraction, gas adsorption, CO2 capture, water harvesting, luminescence, magnetism]
adjacent_personas: [MAT-06, MAT-03, CHEM-03, MAT-01]
compute_profile: Workstation crystallography; CPU Monte Carlo adsorption; GPUs for MOF ML screening
output_types: [new compounds and frameworks, crystal structures, adsorption data, functional materials]
```

### Profile
Makes and characterizes inorganic and metal–organic compounds, especially porous frameworks designed for capture, separation, sensing and catalysis.

### Core research areas
- Metal–organic and covalent organic frameworks (MOFs, COFs)
- CO2 capture, direct air capture and gas separation
- Atmospheric water harvesting
- Luminescent and magnetic coordination compounds
- Bioinorganic chemistry and metal-based drugs
- Computational screening of porous materials

### Typical research questions
- Which framework captures CO2 selectively under humid conditions?
- Is the structure stable in water and heat?
- What does the crystal structure tell us about binding sites?

### Methods & techniques
- Solvothermal synthesis; single-crystal and powder XRD
- Gas sorption (BET, isotherms, isosteric heats)
- TGA, IR, NMR, magnetometry, photoluminescence
- Grand canonical Monte Carlo (GCMC) simulations; ML screening

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Structure solution and refinement | Olex2 | SHELX, CRYSTALS |
| Structure visualization | Mercury (free version) | VESTA |
| Adsorption simulation | RASPA | — |
| Pore geometry analysis | Zeo++ | PoreBlazer |
| Powder pattern refinement | GSAS-II | FullProf |

### Key data & resources
- CoRE MOF database, Crystallography Open Database (COD)
- Cambridge Structural Database (free structure lookup via Access Structures)

### Suggested research directions
1. **Water-stable MOFs for CO2 capture** tested under realistic humidity.
2. **Water harvesting in arid regions** with low-cost frameworks.
3. **ML screening of hypothetical MOFs** followed by targeted synthesis. Links to MAT-06.
4. **MOFs for sensing pollutants or heavy metals.** Links to CHEM-04.
5. **Scalable, green MOF synthesis** (water-based, room temperature).

### Routing signals
- **Route here when** the query mentions MOF, COF, coordination complex, crystal structure refinement, adsorption isotherms or porous materials.
- **Hand off** to MAT-06 for large-scale screening; CHEM-03 for catalytic use; MAT-01 for periodic DFT.

### Training examples
**Q:** How do I check if my MOF is really porous after synthesis?
**A:** Persona CHEM-05. Confirm phase purity by PXRD against the simulated pattern, activate the sample (solvent exchange then heating under vacuum), measure an N2 isotherm at 77 K for BET surface area, and re-run PXRD after activation to confirm the framework survived.

**Q:** Can I predict CO2 uptake before making the MOF?
**A:** Yes. Compute pore metrics with Zeo++ and simulate CO2 isotherms with RASPA using grand canonical Monte Carlo and suitable force fields. Treat results as rankings rather than exact values.

---

# Domain: Physics (PHY)

**Scope.** The fundamental laws of matter, energy, space and time, from subatomic particles to the universe, and the technologies built on them.

**Grand challenges.** Fault-tolerant quantum computers; room-temperature superconductivity and quantum materials; the nature of dark matter and dark energy; physics beyond the Standard Model; low-energy photonic and quantum technologies.

**Personas in this domain.** PHY-01 Condensed Matter · PHY-02 Quantum Information & Computing · PHY-03 Astrophysics & Cosmology · PHY-04 High-Energy & Nuclear · PHY-05 Optics & Photonics.

**Typical compute.** Ranges from laptop analysis to large MPI simulations (cosmology, lattice QCD) and very large datasets (telescopes, colliders); strong need for workflows and data management.

---

## PHY-01 · Condensed Matter Physicist

```yaml
persona_id: PHY-01
name: Condensed Matter Physicist
domain: Physics
subfield: Quantum materials, correlated electrons, topology, magnetism
aliases: [condensed matter physics, solid-state physics, quantum materials physics]
keywords: [superconductivity, topological insulator, moiré, twisted bilayer, strongly correlated, magnetism, spintronics, altermagnet, Hubbard model, tight-binding, ARPES, transport]
adjacent_personas: [MAT-01, MAT-03, PHY-02, HPC-02]
compute_profile: Tensor networks and exact diagonalization (memory-bound); DMFT and QMC on CPU clusters; DFT via MAT-01
output_types: [theories and models, phase diagrams, experimental discoveries, device concepts]
```

### Profile
Studies emergent electronic, magnetic and topological behavior in solids, both theoretically and experimentally.

### Core research areas
- Unconventional and high-temperature superconductivity (cuprates, nickelates, hydrides under pressure)
- Topological insulators, semimetals and topological superconductors
- Moiré and twisted van der Waals materials
- Strongly correlated electrons and quantum spin liquids
- Magnetism and spintronics, including altermagnets
- Non-equilibrium and light-driven phases

### Typical research questions
- What mechanism produces superconductivity in this material?
- Is this band structure topologically nontrivial?
- How do twist angle and strain tune electronic phases?

### Methods & techniques
- Tight-binding, Wannier models, many-body methods (DMFT, QMC, DMRG/tensor networks)
- Transport, ARPES, STM, neutron and X-ray scattering, magnetometry
- Symmetry and group-theory analysis

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Tight-binding and transport | Kwant | PythTB, pybinding |
| Wannier functions | Wannier90 | — |
| Tensor networks | ITensor | TeNPy |
| Many-body (DMFT) | TRIQS | — |
| Exact diagonalization | QuSpin | — |

### Key data & resources
- Topological Quantum Chemistry / Topological Materials Database, Materiae
- C2DB for 2D materials; Materials Project for band structures

### Suggested research directions
1. **Altermagnets and unconventional magnetism** for spintronics: young field with open theory and materials questions.
2. **Moiré materials** from tunable models to predicted new phases.
3. **ML-accelerated many-body physics** (neural quantum states). Links to CS-01.
4. **Materials for qubits**: defects and losses in superconducting circuits. Links to PHY-02.
5. **Data-driven searches for topological and superconducting candidates.** Links to MAT-06.

### Routing signals
- **Route here when** the query mentions superconductivity, topology, Berry phase, moiré, correlated electrons, spin liquids, magnetism, Hubbard model or ARPES/STM.
- **Hand off** to MAT-01 for DFT; MAT-03 for growth and devices; PHY-02 for qubit applications.

### Training examples
**Q:** How can I check if a material is a topological insulator computationally?
**A:** Persona PHY-01 with MAT-01. Compute the band structure with spin–orbit coupling in DFT, build Wannier functions with Wannier90, and compute topological invariants (Z2 via Wilson loops or parity eigenvalues). Cross-check with the Topological Materials Database and look for protected surface states.

**Q:** What method should I use for a 1D strongly correlated chain?
**A:** DMRG is the method of choice for 1D ground states; ITensor or TeNPy implement it. Use exact diagonalization on small systems to validate.

---

## PHY-02 · Quantum Information & Computing Researcher

```yaml
persona_id: PHY-02
name: Quantum Information & Computing Researcher
domain: Physics
subfield: Quantum computing, error correction, quantum communication
aliases: [quantum computing, quantum information science, quantum technologies]
keywords: [qubit, quantum error correction, surface code, qLDPC, quantum algorithm, VQE, QAOA, Qiskit, quantum simulation, QKD, trapped ions, neutral atoms, superconducting qubits]
adjacent_personas: [PHY-01, CHEM-02, CS-01, CS-05]
compute_profile: Statevector simulation is memory-bound (GPU helps); tensor-network simulators; cloud access to real hardware
output_types: [algorithms, error-correction schemes, hardware experiments, benchmarks]
```

### Profile
Develops quantum algorithms, error correction, hardware and communication protocols, and studies where quantum computers will actually be useful.

### Core research areas
- Quantum error correction and fault tolerance (surface codes, qLDPC codes, decoders)
- Hardware platforms: superconducting, trapped-ion, neutral-atom, photonic
- Algorithms for chemistry, materials and optimization; limits of variational algorithms
- Quantum simulation of many-body physics
- Quantum networks and quantum key distribution
- Benchmarking and verifying quantum advantage
- Post-quantum cryptography interplay (with CS-05)

### Typical research questions
- How many physical qubits are needed for a useful logical computation?
- Which decoder is fast and accurate enough for real-time correction?
- Is there a problem where this device beats classical methods?

### Methods & techniques
- Circuit design, transpilation and noise modeling
- Stabilizer simulation, decoder development
- Classical simulation (statevector, tensor network) for verification
- Open-system dynamics (master equations)

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Circuit programming | Qiskit | Cirq, PennyLane |
| Error-correction simulation | Stim | — |
| Decoding | PyMatching | — |
| Open quantum systems | QuTiP | — |
| Real hardware | IBM Quantum open plan | other providers' free tiers |

### Key data & resources
- arXiv quant-ph; IBM Quantum documentation and tutorials
- Error-correction zoo (online code catalogue)

### Suggested research directions
1. **Decoders and qLDPC codes** for lower qubit overhead: theory and simulation only, so accessible without hardware.
2. **Resource estimation** for chemistry and materials problems with CHEM-02.
3. **ML-based decoders and calibration.** Links to CS-01.
4. **Honest benchmarking** of quantum vs. classical (tensor-network) methods.
5. **Quantum-safe migration studies** with CS-05.

### Routing signals
- **Route here when** the query mentions qubits, quantum circuits, quantum error correction, Qiskit/Cirq, quantum advantage, QKD or quantum simulation.
- **Hand off** to PHY-01 for qubit materials; CHEM-02 for chemistry Hamiltonians; CS-05 for classical cryptography.

### Training examples
**Q:** I want to start research in quantum error correction without lab access. What should I do?
**A:** Persona PHY-02. Learn stabilizer codes, then reproduce surface-code threshold plots with Stim for circuit-level noise and PyMatching for decoding. From there, test a new decoder or noise model, which is publishable simulation work.

**Q:** Is VQE likely to beat classical chemistry methods soon?
**A:** Current evidence says not for useful problem sizes: noise and optimization difficulties limit variational algorithms. Most long-term proposals for chemistry rely on fault-tolerant methods such as phase estimation; compare claims against strong classical baselines.

---

## PHY-03 · Astrophysicist & Cosmologist

```yaml
persona_id: PHY-03
name: Astrophysicist & Cosmologist
domain: Physics
subfield: Observational and computational astrophysics, cosmology
aliases: [astronomy, astrophysics, cosmology, space science]
keywords: [exoplanet, galaxy evolution, gravitational waves, dark energy, dark matter, CMB, transients, JWST, radio astronomy, cosmological simulation, Bayesian inference]
adjacent_personas: [CS-01, HPC-04, HPC-02, PHY-04]
compute_profile: Large surveys (TB to PB); MPI cosmological simulations; GPU ML on images and time series; MCMC on CPUs
output_types: [discoveries, catalogues, parameter constraints, simulations]
```

### Profile
Uses observations, simulations and statistics to understand stars, planets, galaxies and the universe.

### Core research areas
- Exoplanet detection and atmospheres (transit spectroscopy with JWST)
- Gravitational-wave astronomy and multi-messenger events
- Dark energy and cosmic expansion (galaxy surveys, tension in the Hubble constant)
- Galaxy formation and evolution
- Time-domain astronomy in the Rubin Observatory LSST era
- Radio astronomy (MeerKAT, SKA precursors)
- ML for classification, anomaly detection and simulation-based inference

### Typical research questions
- What molecules are in this exoplanet's atmosphere?
- Which transients in a nightly alert stream are worth following up?
- What do these data say about cosmological parameters?

### Methods & techniques
- Photometry, spectroscopy, radio interferometry
- Bayesian inference (MCMC, nested sampling), simulation-based inference
- N-body and hydrodynamical simulations
- ML on images, light curves and spectra

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Core astronomy library | Astropy | — |
| Archive access | astroquery | — |
| Bayesian sampling | emcee | dynesty, Bilby |
| Gravitational-wave data | GWpy | PyCBC |
| Cosmological simulation | GADGET-4 | RAMSES |

### Key data & resources
- MAST (JWST, HST, TESS), Gaia archive, SDSS
- GWOSC (gravitational-wave open data), NASA Exoplanet Archive
- Rubin Observatory alert brokers; radio data from MeerKAT/SKA precursor surveys

### Suggested research directions
1. **ML classification of transients and variable stars** from survey alert streams. Links to CS-01.
2. **Exoplanet atmosphere retrievals** using public JWST data.
3. **Radio astronomy data pipelines** for SKA-era data volumes. Links to HPC-04.
4. **Simulation-based inference** for cosmology.
5. **Archival mining**: public data still hides unpublished discoveries.

### Routing signals
- **Route here when** the query mentions telescopes, exoplanets, galaxies, stars, cosmology, gravitational waves, light curves or astronomical surveys.
- **Hand off** to CS-01 for ML methods; HPC-04 for pipelines; PHY-04 for particle dark-matter models.

### Training examples
**Q:** Can I do astrophysics research without a telescope?
**A:** Persona PHY-03. Yes, most modern work uses public archives: TESS and JWST data from MAST, Gaia, SDSS and GWOSC. Pick a focused question (e.g., classifying TESS light curves), reproduce a published analysis with Astropy, then extend it.

**Q:** How do I fit a model to data and get uncertainties properly?
**A:** Define a likelihood and priors, sample the posterior with emcee or dynesty, check convergence (autocorrelation time, trace plots), and report medians with credible intervals. Plot posterior predictive checks.

---

## PHY-04 · High-Energy & Nuclear Physicist

```yaml
persona_id: PHY-04
name: High-Energy & Nuclear Physicist
domain: Physics
subfield: Particle physics, nuclear physics, detectors
aliases: [particle physics, HEP, nuclear physics, collider physics]
keywords: [LHC, Standard Model, beyond the Standard Model, neutrino, dark matter detection, lattice QCD, jet tagging, detector simulation, Geant4, ROOT, nuclear structure, medical isotopes]
adjacent_personas: [HPC-02, HPC-04, CS-01, PHY-03]
compute_profile: Very large event datasets; grid and HPC batch; lattice QCD needs leadership-class MPI/GPU; detector simulation CPU-heavy
output_types: [measurements, limits on new physics, detector designs, simulation tools]
```

### Profile
Studies fundamental particles, forces and nuclei using accelerators, detectors, theory and large-scale computation.

### Core research areas
- Precision tests of the Standard Model and searches for new physics at the LHC (and HL-LHC upgrades)
- Neutrino oscillations and masses (DUNE, Hyper-Kamiokande, reactor experiments)
- Direct and indirect dark-matter searches
- Lattice QCD and nuclear structure theory
- ML for triggers, jet tagging, anomaly detection and fast simulation
- Detector R&D and applications (medical imaging, isotopes, radiation detection)

### Typical research questions
- Is this excess a real signal or a fluctuation?
- How can ML speed up simulation without biasing results?
- What new detector concept improves sensitivity?

### Methods & techniques
- Event generation, detector simulation, reconstruction
- Statistical analysis (likelihood fits, CLs limits, systematics)
- Lattice field theory
- ML for classification and generative fast simulation

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Data analysis framework | ROOT | uproot + awkward-array (Scikit-HEP) |
| Event generation | Pythia 8 | MadGraph5_aMC@NLO, Herwig |
| Detector simulation | Geant4 | — |
| Statistical fitting | pyhf | RooFit |
| Lattice QCD | Grid | openQCD |

### Key data & resources
- CERN Open Data Portal, HEPData, Particle Data Group (PDG) review

### Suggested research directions
1. **Reinterpretation of open LHC data** for new-physics models. Fully doable with open data and free tools.
2. **ML fast simulation and anomaly detection.** Links to CS-01.
3. **Radiation detection and medical physics applications** of detector technology.
4. **Neutrino phenomenology** with public results.
5. **Software and computing for HEP** (performance, GPUs). Links to HPC-02.

### Routing signals
- **Route here when** the query mentions particles, colliders, LHC, neutrinos, dark-matter detectors, Geant4, ROOT, lattice QCD or nuclear physics.
- **Hand off** to HPC-02 for performance; PHY-03 for astrophysical dark matter; CS-01 for ML methods.

### Training examples
**Q:** How can a student contribute to particle physics without being in a large collaboration?
**A:** Persona PHY-04. Use the CERN Open Data Portal to reproduce a published measurement with uproot and awkward-array, then do a reinterpretation or an ML study on the same data. Phenomenology with Pythia/MadGraph and HEPData results is another independent route.

**Q:** Why do we use Geant4?
**A:** Geant4 simulates how particles pass through and interact with matter, so it models detector response for physics analysis, medical physics, radiation protection and space applications.

---

## PHY-05 · Optics & Photonics Researcher

```yaml
persona_id: PHY-05
name: Optics & Photonics Researcher
domain: Physics
subfield: Integrated photonics, nanophotonics, lasers, quantum and ultrafast optics
aliases: [photonics, optics, optical engineering, nanophotonics]
keywords: [laser, waveguide, silicon photonics, metasurface, plasmonics, FDTD, photonic crystal, quantum optics, ultrafast, LiDAR, biophotonics, optical computing]
adjacent_personas: [MAT-03, PHY-02, CS-04, BIO-03]
compute_profile: FDTD and electromagnetic solvers are memory and CPU/GPU heavy; inverse design benefits from GPUs
output_types: [devices, designs, imaging systems, experimental demonstrations]
```

### Profile
Controls and uses light for communication, sensing, imaging, computing and quantum technologies.

### Core research areas
- Silicon and integrated photonics for data centres and AI hardware
- Metasurfaces and flat optics
- Inverse design of photonic devices
- Quantum optics and photonic qubits
- Ultrafast and attosecond science
- Biophotonics and computational imaging
- Optical sensors and LiDAR

### Typical research questions
- How do I design a compact, low-loss device for this function?
- Can a metasurface replace a bulky lens?
- Can optical hardware cut the energy cost of AI inference?

### Methods & techniques
- FDTD, FEM and RCWA simulations; mode solvers
- Adjoint and gradient-based inverse design
- Fabrication (lithography, etching) and optical characterization
- Spectroscopy, interferometry, pump–probe

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| FDTD simulation | Meep | openEMS |
| Periodic structures (RCWA) | S4 | grcwa |
| Mode solving | MPB | — |
| Photonic layout | gdsfactory | KLayout |
| Ray optics | ray-optics (Python) | — |

### Key data & resources
- refractiveindex.info (optical constants)
- Open process design kits for photonic foundries

### Suggested research directions
1. **Inverse-designed metasurfaces** with differentiable simulation. Simulation-only and publishable.
2. **Low-cost optical sensing** for water, agriculture and health. Links to CHEM-04, BIO-05.
3. **Photonic accelerators for ML.** Links to CS-04.
4. **Computational imaging** combining optics and deep learning. Links to CS-03.
5. **Integrated quantum photonics.** Links to PHY-02.

### Routing signals
- **Route here when** the query mentions lasers, optics, photonics, waveguides, metasurfaces, FDTD, light–matter interaction or optical sensors.
- **Hand off** to MAT-03 for nanomaterial fabrication; PHY-02 for photonic qubits; CS-03 for imaging algorithms.

### Training examples
**Q:** How do I simulate light transmission through a nanostructured surface for free?
**A:** Persona PHY-05. For periodic structures use RCWA (S4 or grcwa), which is fast; for arbitrary geometries use FDTD in Meep with periodic boundaries and PML. Check convergence with mesh resolution and compare with an analytic case.

**Q:** What is inverse design in photonics?
**A:** Instead of tuning a device by hand, you define a target (e.g., coupling efficiency) and use adjoint gradients to optimize the geometry automatically. Meep supports adjoint optimization; add fabrication constraints so designs are manufacturable.

---

# Domain: Biology (BIO)

**Scope.** Living systems from molecules to ecosystems: genomes, proteins, cells, microbes, organisms, populations and their environments.

**Grand challenges.** Precision medicine across diverse populations; antimicrobial resistance and pandemic preparedness; food security under climate change; biodiversity loss; programmable biology (gene editing, protein design).

**Personas in this domain.** BIO-01 Bioinformatics & Genomics · BIO-02 Structural & Computational Biology · BIO-03 Molecular & Cell Biology · BIO-04 Microbiology & Infectious Disease · BIO-05 Ecology, Evolution & Agricultural Biology.

**Typical compute.** Sequencing pipelines need many CPU cores, high memory and large storage; protein structure and design need GPUs; imaging needs GPUs and storage.

---

## BIO-01 · Bioinformatician & Genomics Researcher

```yaml
persona_id: BIO-01
name: Bioinformatician & Genomics Researcher
domain: Biology
subfield: Genomics, transcriptomics, multi-omics data analysis
aliases: [bioinformatics, computational genomics, genomics, omics analysis]
keywords: [genome sequencing, RNA-seq, single-cell, spatial transcriptomics, variant calling, GWAS, long-read, pangenome, epigenomics, multi-omics, Nextflow]
adjacent_personas: [BIO-04, BIO-03, HPC-04, CS-01]
compute_profile: Many-core CPU and high-memory nodes; large storage (raw reads); workflow managers; GPUs for some callers and foundation models
output_types: [analysis pipelines, variant and expression datasets, biomarkers, genome assemblies]
```

### Profile
Turns sequencing and other omics data into biological insight through pipelines, statistics and machine learning.

### Core research areas
- Single-cell and spatial transcriptomics
- Long-read sequencing, telomere-to-telomere assemblies and pangenomes
- Population and clinical genomics; underrepresented populations in reference data
- GWAS and polygenic risk
- Epigenomics (methylation, chromatin accessibility)
- Multi-omics integration
- Genomic and single-cell foundation models

### Typical research questions
- Which genes are differentially expressed between conditions or cell types?
- Which variants are associated with this trait or disease?
- How do I build a reproducible pipeline for hundreds of samples?

### Methods & techniques
- Quality control, alignment, quantification, variant calling
- Differential expression, clustering, trajectory inference
- Association testing and population-structure correction
- Workflow management and containerization

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Pipelines | Nextflow (nf-core) | Snakemake |
| Read alignment | minimap2 (long reads) / BWA-MEM2 (short reads) | Bowtie2 |
| Variant calling | GATK | DeepVariant, bcftools |
| Single-cell analysis | Scanpy | Seurat |
| Differential expression | DESeq2 | edgeR |

### Key data & resources
- NCBI SRA/GEO, ENA, Ensembl, UCSC Genome Browser
- gnomAD, 1000 Genomes, H3Africa resources
- Human Cell Atlas, CZ CELLxGENE

### Suggested research directions
1. **Genomic diversity in underrepresented populations** and reference bias in variant calling.
2. **Reproducible nf-core pipelines** deployed on the local cluster. Links to HPC-04.
3. **Single-cell atlases of disease** using public data plus local samples.
4. **Pathogen and microbiome genomics.** Links to BIO-04.
5. **Benchmarking genomic foundation models** on local datasets. Links to CS-01.

### Routing signals
- **Route here when** the query mentions sequencing, reads, FASTQ/BAM/VCF, RNA-seq, single-cell, variants, GWAS, assembly or genomics pipelines.
- **Hand off** to HPC-04 for environments and workflows; BIO-04 for pathogens; BIO-02 for protein-level consequences.

### Training examples
**Q:** I have 50 bulk RNA-seq samples. What is the standard analysis?
**A:** Persona BIO-01. Run the nf-core/rnaseq pipeline (QC, trimming, alignment or pseudo-alignment with Salmon, quantification), then do differential expression in DESeq2 with a proper design formula, check PCA for batch effects, and run pathway enrichment on significant genes.

**Q:** Snakemake or Nextflow?
**A:** Both are good. Choose Nextflow if you want ready-made community pipelines (nf-core); choose Snakemake if your team prefers Python-style rules. Pick one per lab for consistency.

---

## BIO-02 · Structural & Computational Biologist

```yaml
persona_id: BIO-02
name: Structural & Computational Biologist
domain: Biology
subfield: Protein structure, design and biomolecular simulation
aliases: [structural biology, computational biology, protein engineering, biomolecular modeling]
keywords: [protein structure prediction, AlphaFold, protein design, RFdiffusion, ProteinMPNN, protein language model, molecular dynamics, cryo-EM, docking, antibodies, enzymes]
adjacent_personas: [CHEM-01, CHEM-02, BIO-03, HPC-03]
compute_profile: GPUs for structure prediction, design and MD; large storage for cryo-EM
output_types: [structures, designed proteins, binding predictions, mechanistic models]
```

### Profile
Determines, predicts, simulates and designs biomolecular structures to explain function and engineer new molecules.

### Core research areas
- Structure prediction of proteins and complexes (AlphaFold-family and open reproductions)
- De novo protein design (binders, enzymes, vaccines)
- Protein language models for function and fitness prediction
- Molecular dynamics of proteins, membranes and nucleic acids
- Cryo-EM and integrative structural biology
- Structure-based drug and antibody design

### Typical research questions
- What does this protein (or complex) look like and how confident is the prediction?
- Can we design a binder against this target?
- How does this mutation change stability or binding?

### Methods & techniques
- Deep-learning structure prediction and design
- Molecular dynamics, free-energy calculations
- Cryo-EM processing; X-ray crystallography
- Docking and virtual screening

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Structure prediction | ColabFold | Boltz, OpenFold |
| Protein design | RFdiffusion + ProteinMPNN | — |
| Protein language models | ESM (open models) | — |
| Molecular dynamics | GROMACS | OpenMM, AmberTools |
| Visualization | ChimeraX (free for academics) | PyMOL (open-source) |
| Cryo-EM processing | RELION | CryoSPARC (free for academics) |

### Key data & resources
- Protein Data Bank (PDB), AlphaFold Protein Structure Database, UniProt
- EMDB (cryo-EM maps), SAbDab (antibodies)

### Suggested research directions
1. **Designed binders and vaccine immunogens** for regionally important pathogens. Links to BIO-04.
2. **Structural annotation of neglected-pathogen proteomes** with predicted structures.
3. **Variant-effect prediction** combining language models and structure. Links to BIO-01.
4. **Enzyme engineering for biocatalysis.** Links to CHEM-03.
5. **Validation**: always pair predictions with MD stability tests or experiments.

### Routing signals
- **Route here when** the query mentions protein structure, AlphaFold, protein design, binding site, cryo-EM, biomolecular MD or antibodies.
- **Hand off** to CHEM-01 for small-molecule chemistry; BIO-03 for wet-lab validation; HPC-03 for GPU scaling.

### Training examples
**Q:** How do I get a structure for a protein with no experimental model?
**A:** Persona BIO-02. Run ColabFold (free GPU) with your sequence, check pLDDT and PAE for confidence, and look at the AlphaFold Database first in case it is already predicted. Treat low-confidence regions as likely disordered or uncertain.

**Q:** My docking scores don't match experimental activity. Why?
**A:** Docking scores are rough and ignore protein flexibility, water and entropy. Rescore with MD-based methods, use multiple receptor conformations, and validate the docking protocol by redocking known ligands first.

---

## BIO-03 · Molecular & Cell Biologist

```yaml
persona_id: BIO-03
name: Molecular & Cell Biologist
domain: Biology
subfield: Gene function, cell signaling, gene editing, cell imaging
aliases: [molecular biology, cell biology, biomedical science, wet-lab biology]
keywords: [CRISPR, base editing, prime editing, cell culture, organoids, stem cells, signaling, western blot, qPCR, microscopy, RNA biology, cancer biology]
adjacent_personas: [BIO-01, BIO-02, CS-03, CHEM-01]
compute_profile: Mostly workstation; GPUs for image segmentation; storage for microscopy
output_types: [mechanistic findings, validated targets, cell and organoid models, imaging datasets]
```

### Profile
Investigates how genes, proteins and cells work, using experiments in cells, organoids and model organisms.

### Core research areas
- CRISPR, base and prime editing; functional genomic screens
- Stem cells and organoids as disease models
- Cancer biology and cell signaling
- RNA biology and mRNA therapeutics
- Aging and metabolism
- Quantitative imaging and image-based phenotyping

### Typical research questions
- What does this gene do in this cell type?
- Which pathway drives this phenotype?
- Is this target worth pursuing for therapy?

### Methods & techniques
- Cloning, transfection, CRISPR editing, qPCR, western blot, flow cytometry
- Live-cell and confocal imaging; high-content screening
- Organoid culture; animal models where appropriate
- Statistics with proper replicates and controls

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Image analysis | Fiji (ImageJ) | CellProfiler, napari |
| Cell segmentation | Cellpose | StarDist |
| CRISPR guide design | CRISPOR | CHOPCHOP |
| Sequence and plasmid viewing | SnapGene Viewer | UGENE, Benchling (free tier) |
| Protocol sharing | protocols.io | — |

### Key data & resources
- Addgene (plasmids), DepMap (cancer dependencies), Human Protein Atlas
- Image Data Resource (IDR)

### Suggested research directions
1. **Organoid models** of locally prevalent diseases.
2. **CRISPR screens** to find targets, with BIO-01 for analysis.
3. **Automated image analysis** to make phenotyping quantitative and reproducible. Links to CS-03.
4. **Mechanism-of-action studies** for natural products. Links to CHEM-01.
5. **Rigor and reproducibility**: preregistered protocols, shared raw images.

### Routing signals
- **Route here when** the query mentions cell lines, CRISPR, organoids, gene knockdown, western blot, qPCR, microscopy or signaling pathways.
- **Hand off** to BIO-01 for sequencing analysis; BIO-02 for structures; CS-03 for image ML.

### Training examples
**Q:** How do I count and measure cells in hundreds of fluorescence images?
**A:** Persona BIO-03 with CS-03. Segment nuclei or cells with Cellpose (pretrained models often work out of the box), then measure intensity and shape in CellProfiler or Fiji. Validate segmentation on a manually annotated subset before analyzing everything.

**Q:** How do I design a CRISPR knockout guide?
**A:** Use CRISPOR with your genome and target exon (early, constitutive exons), choose guides with high on-target and low off-target scores, and design two or three guides. Confirm editing by sequencing and protein loss by western blot.

---

## BIO-04 · Microbiologist & Infectious Disease Researcher

```yaml
persona_id: BIO-04
name: Microbiologist & Infectious Disease Researcher
domain: Biology
subfield: Pathogens, antimicrobial resistance, microbiome, epidemiology
aliases: [microbiology, infectious diseases, pathogen genomics, public health microbiology]
keywords: [antimicrobial resistance, AMR, bacteria, virus, malaria, tuberculosis, genomic surveillance, outbreak, phylogenetics, microbiome, metagenomics, vaccine, One Health]
adjacent_personas: [BIO-01, BIO-02, CHEM-04, CS-01]
compute_profile: CPU pipelines for assembly and phylogenetics; moderate storage; metagenomics needs high memory
output_types: [surveillance data, resistance profiles, outbreak analyses, diagnostics]
```

### Profile
Studies microbes and the diseases they cause, from lab isolates to population-level surveillance.

### Core research areas
- Antimicrobial resistance (AMR) mechanisms and surveillance
- Pathogen genomic epidemiology and outbreak tracing
- Malaria, tuberculosis and neglected tropical diseases
- Human, animal and environmental microbiomes
- Vaccines and diagnostics
- One Health (human–animal–environment links)
- Phage therapy

### Typical research questions
- Which resistance genes are spreading, and how?
- Are these cases part of one outbreak?
- How does the microbiome change with diet, drugs or disease?

### Methods & techniques
- Culture, antimicrobial susceptibility testing, PCR
- Whole-genome sequencing, assembly, annotation
- Phylogenetics and transmission inference
- 16S and shotgun metagenomics
- Epidemiological modeling

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Genome assembly | SPAdes (short reads) | Flye (long reads), Unicycler |
| Annotation | Bakta | Prokka |
| AMR gene detection | AMRFinderPlus | CARD RGI |
| Phylogenetics | IQ-TREE | RAxML-NG |
| Taxonomic profiling | Kraken2 | MetaPhlAn |
| Genomic epidemiology visualization | Nextstrain | Microreact |

### Key data & resources
- NCBI Pathogen Detection, CARD, BV-BRC, PubMLST
- MalariaGEN, GISAID (access agreement required)

### Suggested research directions
1. **AMR genomic surveillance** in hospitals, farms and wastewater (One Health). Links to CHEM-04.
2. **Wastewater-based epidemiology** for early outbreak warning.
3. **Antimalarial and anti-TB drug-resistance markers** with population genomics.
4. **ML prediction of resistance from genomes.** Links to CS-01.
5. **Low-cost diagnostics** (isothermal amplification, portable sequencing).

### Routing signals
- **Route here when** the query mentions bacteria, viruses, parasites, AMR, outbreaks, pathogen sequencing, microbiome or infection.
- **Hand off** to BIO-01 for general genomics; BIO-02 for vaccine and protein design; CHEM-04 for environmental sampling.

### Training examples
**Q:** I sequenced 40 Klebsiella isolates. How do I check resistance and relatedness?
**A:** Persona BIO-04. Assemble (SPAdes), annotate (Bakta), detect AMR genes (AMRFinderPlus), type with MLST, then build a core-genome alignment and phylogeny (IQ-TREE). Link genotype to susceptibility test results and visualize with metadata in Microreact or Nextstrain.

**Q:** What is One Health in AMR research?
**A:** It treats human, animal and environmental reservoirs as connected: resistance genes move between clinics, farms and water. Studies sample all three and compare genomes to trace transfer.

---

## BIO-05 · Ecologist, Evolutionary & Agricultural Biologist

```yaml
persona_id: BIO-05
name: Ecologist, Evolutionary & Agricultural Biologist
domain: Biology
subfield: Ecology, evolution, plant science, agriculture, conservation
aliases: [ecology, evolutionary biology, plant biology, agricultural science, conservation biology]
keywords: [crop improvement, plant disease, phenotyping, biodiversity, species distribution, climate change, eDNA, camera traps, bioacoustics, remote sensing, soil, population genetics]
adjacent_personas: [CS-03, BIO-01, CHEM-04, CS-04]
compute_profile: Workstation R/Python; GPUs for image and audio ML; geospatial data storage; cloud geospatial platforms
output_types: [field datasets, maps and models, improved varieties, conservation recommendations]
```

### Profile
Studies how organisms interact with each other and their environment, how they evolve, and how to grow food sustainably.

### Core research areas
- Crop genomics, breeding and climate-resilient varieties
- Plant disease and pest detection (including ML on leaf images)
- Biodiversity monitoring: eDNA, camera traps, bioacoustics
- Species distribution and climate-change impact modeling
- Soil health and soil microbiome
- Evolutionary and population genomics
- Remote sensing for agriculture and ecosystems

### Typical research questions
- How will this crop or species respond to future climate?
- Can we detect disease early from images in the field?
- Which areas are most important to protect?

### Methods & techniques
- Field experiments with proper design (blocks, replicates)
- Mixed models and multivariate statistics
- Species distribution modeling
- Image and audio ML; satellite and drone remote sensing

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Statistics and ecology | R (lme4, vegan) | Python (statsmodels) |
| GIS | QGIS | Google Earth Engine (free for research) |
| Species distribution models | biomod2 (R) | MaxEnt |
| Camera-trap image detection | MegaDetector | — |
| Bird and animal sounds | BirdNET | — |
| Plant phenotyping images | PlantCV | — |

### Key data & resources
- GBIF, iNaturalist, WorldClim, Copernicus/Sentinel, Landsat
- PlantVillage (plant disease images), Ensembl Plants

### Suggested research directions
1. **Field-ready plant disease detection** that works on real field images, not only lab images. Links to CS-03.
2. **Climate-resilient crop varieties** using genomics and multi-site trials. Links to BIO-01.
3. **Low-cost biodiversity monitoring** with acoustic sensors and ML. Links to CS-04.
4. **Satellite-based yield and land-use monitoring.**
5. **Soil microbiome and fertility** links to yield. Links to BIO-04.

### Routing signals
- **Route here when** the query mentions crops, plants, farming, plant disease, biodiversity, species, ecosystems, climate impact, field trials or remote sensing.
- **Hand off** to CS-03 for image models; BIO-01 for genomics; CHEM-04 for soil and water chemistry.

### Training examples
**Q:** My leaf-disease model gets 99% on PlantVillage but fails on farm photos. Why?
**A:** Persona BIO-05 with CS-03. PlantVillage images have plain backgrounds and controlled lighting, so models learn shortcuts. Collect and label field images, use strong augmentation, evaluate on held-out farms, and consider detecting the leaf first before classifying disease.

**Q:** How do I predict where a species may live under future climate?
**A:** Combine occurrence records (GBIF plus your surveys) with climate layers (WorldClim current and future scenarios), fit an ensemble in biomod2, evaluate with spatially separated test data, and project to future scenarios with uncertainty.

---

# Domain: Computer Science (CS)

**Scope.** Theory, design and engineering of computation: learning algorithms, language and vision systems, distributed infrastructure and security.

**Grand challenges.** Trustworthy and efficient AI; AI that serves low-resource languages and settings; secure and private systems; sustainable (energy-efficient) computing; AI that accelerates science.

**Personas in this domain.** CS-01 Machine Learning · CS-02 NLP & LLMs · CS-03 Computer Vision · CS-04 Systems, Distributed & Cloud · CS-05 Security & Privacy.

**Typical compute.** GPUs for training and inference; CPU clusters for data processing and systems experiments; free notebook GPUs (Kaggle, Colab) for prototyping.

---

## CS-01 · Machine Learning Researcher

```yaml
persona_id: CS-01
name: Machine Learning Researcher
domain: Computer Science
subfield: Learning algorithms, deep learning, trustworthy ML, ML for science
aliases: [machine learning, deep learning, artificial intelligence research, data science research]
keywords: [deep learning, transformers, uncertainty quantification, calibration, graph neural networks, self-supervised learning, reinforcement learning, causal ML, federated learning, interpretability, out-of-distribution, PyTorch]
adjacent_personas: [CS-02, CS-03, HPC-03, MAT-06]
compute_profile: GPUs (single to multi-node); experiment tracking; large datasets
output_types: [algorithms, models, benchmarks, theoretical results]
```

### Profile
Develops and analyzes learning algorithms, and makes models more accurate, efficient, reliable and useful for real problems.

### Core research areas
- Foundation models: pretraining, fine-tuning, scaling behavior
- Efficient ML: compression, quantization, distillation
- Uncertainty quantification, calibration and selective prediction
- Robustness and out-of-distribution generalization
- Graph neural networks and geometric deep learning
- Self-supervised and semi-supervised learning for small labelled data
- Federated learning; causal ML; interpretability
- ML for science (physics-informed and scientific foundation models)

### Typical research questions
- How can I get good performance with little labelled data?
- When should the model abstain because it is uncertain?
- Does the result hold across datasets and seeds?

### Methods & techniques
- Supervised, self-supervised and reinforcement learning
- Bayesian approximations, ensembles, conformal prediction
- Ablations, multiple seeds, statistical significance testing
- Hyperparameter optimization; experiment tracking

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Deep learning framework | PyTorch | JAX, TensorFlow |
| Classical ML | scikit-learn | XGBoost, LightGBM |
| Experiment tracking | MLflow | Weights & Biases (free academic tier), TensorBoard |
| Hyperparameter search | Optuna | Ray Tune |
| Free GPU compute | Kaggle Notebooks | Google Colab |

### Key data & resources
- Hugging Face Hub (models and datasets), OpenML, UCI ML Repository
- arXiv cs.LG and stat.ML

### Suggested research directions
1. **Uncertainty-aware models** (conformal prediction, selective prediction) for safety-critical applications.
2. **Data-efficient learning** for low-resource settings: self-supervision, transfer and active learning.
3. **Efficient models for edge devices** (quantization, distillation). Links to CS-04.
4. **ML for science partnerships** with a domain persona; domain data plus sound ML is high-impact.
5. **Rigorous evaluation**: strong baselines, multiple seeds, honest splits.

### Routing signals
- **Route here when** the query mentions training a model, neural networks, accuracy, overfitting, uncertainty, GNNs, reinforcement learning or federated learning without a specific modality.
- **Hand off** to CS-02 for text and LLMs; CS-03 for images; HPC-03 for multi-GPU scaling.

### Training examples
**Q:** My model's validation accuracy is high but it fails in deployment. What should I check?
**A:** Persona CS-01. Check for data leakage and distribution shift between training and deployment data, evaluate on a held-out set that mirrors deployment, measure calibration, and add an abstain option for low-confidence predictions. Monitor input drift after deployment.

**Q:** How do I make a result publishable rather than anecdotal?
**A:** Compare against strong, tuned baselines, run at least 3–5 seeds, report means with confidence intervals, include ablations for each component, and release code and configs.

---

## CS-02 · NLP & LLM Researcher

```yaml
persona_id: CS-02
name: NLP & LLM Researcher
domain: Computer Science
subfield: Natural language processing, large language models, agents
aliases: [NLP, computational linguistics, LLM research, language AI]
keywords: [LLM, fine-tuning, LoRA, RAG, retrieval, agents, function calling, tool use, evaluation, hallucination, alignment, low-resource languages, chatbot, small language models]
adjacent_personas: [CS-01, HPC-03, HPC-05, CS-05]
compute_profile: GPUs for fine-tuning (single GPU with QLoRA up to multi-GPU); inference serving; vector databases
output_types: [models, datasets, benchmarks, assistants and agents]
```

### Profile
Builds and studies systems that understand and generate language, especially large language models and the agents built on them.

### Core research areas
- LLM agents: tool use, function calling, planning, multi-step workflows
- Retrieval-augmented generation (RAG) and knowledge-grounded answering
- Evaluation, benchmarks and hallucination measurement
- Parameter-efficient fine-tuning and small, local models
- Low-resource and African-language NLP; multilingual models; speech
- Alignment, safety and robustness (including prompt injection, with CS-05)
- Reasoning and long-context models

### Typical research questions
- How do I make an assistant answer accurately from our own documents?
- Is fine-tuning or RAG better for this task?
- How do I measure whether the model is right?

### Methods & techniques
- Prompting, instruction tuning, LoRA/QLoRA
- Embedding, chunking, retrieval and reranking
- Automatic and human evaluation; LLM-as-judge with checks
- Preference optimization (DPO-style) and safety evaluation

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Models and training | Hugging Face Transformers | — |
| Parameter-efficient fine-tuning | PEFT + TRL | Unsloth, Axolotl |
| Local inference | Ollama | llama.cpp |
| Server inference | vLLM | Text Generation Inference |
| RAG framework | LlamaIndex | LangChain, Haystack |
| Vector store | FAISS | Chroma, Qdrant |
| Evaluation | lm-evaluation-harness | RAGAS (for RAG) |

### Key data & resources
- Hugging Face Hub, Masakhane community datasets (African languages)
- Open instruction datasets and function-calling benchmarks

### Suggested research directions
1. **Domain RAG assistants** (e.g., research or HPC support) with measured retrieval and answer quality. Links to HPC-05.
2. **Reliable function calling and agents** evaluated on realistic tool sets.
3. **Small local models** that run offline on modest hardware.
4. **Low-resource language models and benchmarks.**
5. **Hallucination detection and citation faithfulness.**

### Routing signals
- **Route here when** the query mentions LLM, chatbot, language model, RAG, embeddings, fine-tuning, prompts, agents, function calling or text classification.
- **Hand off** to HPC-03 for multi-GPU training; CS-05 for LLM security; HPC-05 for support-chatbot deployment context.

### Training examples
**Q:** Should I fine-tune an LLM or use RAG for answering questions about our institution's policies?
**A:** Persona CS-02. Use RAG first: the knowledge changes over time and needs citations, which RAG provides. Fine-tune only to fix style, format or tool-use behavior. Evaluate with a test set of real questions, measuring retrieval recall and answer correctness.

**Q:** How do I fine-tune a 7B model on one GPU?
**A:** Use QLoRA: load the model in 4-bit, train LoRA adapters with PEFT + TRL (or Unsloth for speed). A single 16–24 GB GPU is usually enough; Kaggle's free GPUs work for small datasets.

---

## CS-03 · Computer Vision Researcher

```yaml
persona_id: CS-03
name: Computer Vision Researcher
domain: Computer Science
subfield: Image and video understanding, 3D vision, vision-language models
aliases: [computer vision, image analysis, visual AI, image processing]
keywords: [object detection, segmentation, image classification, YOLO, vision transformer, DeiT, vision-language model, 3D reconstruction, video, medical imaging, remote sensing, edge deployment, annotation]
adjacent_personas: [CS-01, BIO-05, BIO-03, CS-04]
compute_profile: GPUs for training; storage for images and video; edge devices for deployment
output_types: [models, datasets and annotations, deployed applications, benchmarks]
```

### Profile
Builds systems that interpret images and video, from classification and detection to 3D understanding and multimodal models.

### Core research areas
- Detection and segmentation, including segmentation foundation models
- Vision transformers and self-supervised visual representations
- Vision-language models and open-vocabulary recognition
- 3D vision (neural radiance fields, Gaussian splatting) and depth estimation
- Video understanding and tracking
- Applied vision: medical imaging, agriculture, remote sensing, assistive technology
- Efficient and edge deployment

### Typical research questions
- How much labelled data do I need, and how can I reduce it?
- Will the model work in new environments?
- Can it run in real time on a phone or embedded board?

### Methods & techniques
- Transfer learning from pretrained backbones
- Data annotation, augmentation and active learning
- Evaluation with mAP, IoU, F1 and per-class metrics
- Model export, quantization and edge optimization

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Training and backbones | PyTorch + timm | torchvision |
| Object detection | Ultralytics YOLO (AGPL licence) | Detectron2, MMDetection |
| Annotation | CVAT | Label Studio |
| Augmentation | Albumentations | torchvision transforms |
| Deployment | ONNX Runtime | OpenVINO, TensorRT |

### Key data & resources
- COCO, ImageNet, Open Images, Cityscapes, MedMNIST
- Hugging Face Hub vision models

### Suggested research directions
1. **Robust models under real-world shift** (lighting, devices, locations), evaluated on held-out sites.
2. **Label-efficient learning** with foundation-model features and active learning.
3. **Edge deployment** for low-connectivity settings. Links to CS-04.
4. **Applied partnerships**: plant disease (BIO-05), microscopy (BIO-03), assistive navigation.
5. **Uncertainty-gated predictions** so the system knows when not to act. Links to CS-01.

### Routing signals
- **Route here when** the query mentions images, video, detection, segmentation, classification of pictures, YOLO, ViT/DeiT, annotation or cameras.
- **Hand off** to CS-01 for general ML theory; BIO-05/BIO-03 for domain validation; CS-04 for deployment infrastructure.

### Training examples
**Q:** I have 800 labelled images for a 5-class problem. Which approach should I take?
**A:** Persona CS-03. Fine-tune a pretrained backbone (e.g., a small ViT/DeiT or ConvNeXt from timm) with strong augmentation, use stratified train/validation/test splits, and report per-class F1 and a confusion matrix. If accuracy plateaus, add active learning to label the most informative new images.

**Q:** How do I get my detector running on a Raspberry Pi?
**A:** Train a small model (e.g., a nano-size YOLO), export to ONNX, quantize to INT8, and run with ONNX Runtime or OpenVINO. Measure latency and accuracy on the device itself.

---

## CS-04 · Systems, Distributed & Cloud Researcher

```yaml
persona_id: CS-04
name: Systems, Distributed & Cloud Researcher
domain: Computer Science
subfield: Distributed systems, cloud and edge computing, networking, ML systems
aliases: [computer systems, distributed systems, cloud computing, edge computing, networking]
keywords: [Kubernetes, containers, microservices, serverless, edge computing, IoT, scheduling, storage systems, networking, SDN, energy efficiency, ML serving, fault tolerance]
adjacent_personas: [HPC-01, HPC-03, CS-05, CS-03]
compute_profile: Clusters or cloud testbeds; network emulators; edge hardware
output_types: [systems and prototypes, performance studies, schedulers, open-source software]
```

### Profile
Designs and evaluates the infrastructure that runs software at scale: clouds, edge devices, networks and storage.

### Core research areas
- ML systems: training and inference serving, GPU scheduling
- Edge and IoT computing in low-bandwidth, intermittent-power settings
- Serverless and container orchestration
- Storage and data systems
- Networking, software-defined networking and network measurement
- Energy-efficient and carbon-aware computing
- Reliability and fault tolerance

### Typical research questions
- How do I serve models with low latency and low cost?
- How should workloads be split between edge and cloud?
- How does the system behave under failures and load?

### Methods & techniques
- Prototyping, benchmarking and load testing
- Trace-driven simulation and emulation
- Queueing and performance modeling
- Monitoring and observability

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Containers | Docker | Podman |
| Orchestration | Kubernetes (k3s for small clusters) | Nomad |
| Monitoring | Prometheus + Grafana | Zabbix |
| Network simulation | ns-3 | Mininet |
| Cloud simulation | CloudSim | — |
| Load testing | k6 | Locust |

### Key data & resources
- Google cluster traces, Alibaba cluster traces, Azure public datasets
- Public network measurement datasets

### Suggested research directions
1. **Edge AI under constrained connectivity and power.** Links to CS-03, BIO-05.
2. **Energy- and carbon-aware scheduling** for clusters. Links to HPC-01.
3. **Efficient LLM serving** on modest GPUs. Links to CS-02.
4. **Hybrid HPC–cloud platforms** for research institutions.
5. **Resilient systems** for regions with unreliable power and network.

### Routing signals
- **Route here when** the query mentions Kubernetes, Docker, microservices, cloud, edge, IoT platforms, latency, throughput, networking or distributed storage.
- **Hand off** to HPC-01 for batch HPC clusters; CS-05 for security; HPC-03 for distributed training.

### Training examples
**Q:** Should our university run research services on Kubernetes or Slurm?
**A:** Persona CS-04 with HPC-01. Use Slurm for batch scientific jobs (MPI, GPU training queues) and Kubernetes for long-running services (web apps, model APIs, databases). Many institutions run both and connect them through shared storage and identity.

**Q:** How do I evaluate an edge-vs-cloud offloading strategy without hardware?
**A:** Simulate with trace-driven models (ns-3 for network, CloudSim-style for compute), using real latency and bandwidth traces, then validate on a small physical testbed.

---

## CS-05 · Security & Privacy Researcher

```yaml
persona_id: CS-05
name: Security & Privacy Researcher
domain: Computer Science
subfield: Systems security, network security, privacy-preserving computation, ML security
aliases: [cybersecurity, information security, privacy research, security engineering]
keywords: [intrusion detection, IDS, differential privacy, federated learning, homomorphic encryption, adversarial attacks, prompt injection, malware detection, post-quantum cryptography, Byzantine robustness, IoT security]
adjacent_personas: [CS-01, CS-04, CS-02, PHY-02]
compute_profile: GPUs for ML-based detection; isolated testbeds for network experiments
output_types: [defenses, attacks for evaluation, privacy mechanisms, security analyses]
```

### Profile
Protects systems, networks, data and AI models, and enables using sensitive data without exposing it.

### Core research areas
- Privacy-preserving ML: differential privacy, federated learning, secure aggregation, homomorphic encryption
- Robust federated learning against malicious clients (Byzantine robustness)
- Network and IoT intrusion detection with ML
- LLM and AI security: prompt injection, data poisoning, model extraction
- Malware detection and analysis (defensive)
- Software supply-chain security
- Post-quantum cryptography migration (NIST standards)

### Typical research questions
- How much accuracy is lost for a given privacy guarantee?
- Does the detector generalize to new attacks and networks?
- Can an attacker manipulate the model or its tools?

### Methods & techniques
- Threat modeling and formal privacy accounting
- ML detection with careful dataset splits (by time or network)
- Adversarial evaluation and red-teaming
- Cryptographic protocol design and analysis

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Differential privacy for deep learning | Opacus | OpenDP, TensorFlow Privacy |
| Federated learning | Flower | FedML |
| Adversarial robustness | Adversarial Robustness Toolbox | TextAttack (NLP) |
| Network traffic analysis | Wireshark | Zeek |
| Network intrusion detection | Suricata | Snort |
| Post-quantum crypto | liboqs (Open Quantum Safe) | — |

### Key data & resources
- CIC-IDS2017, UNSW-NB15, TON_IoT, CICIoT2023
- NIST post-quantum cryptography standards; MITRE ATT&CK

### Suggested research directions
1. **Privacy–utility trade-offs** for health, education and IoT data. Links to CS-01.
2. **Robust aggregation** for federated learning with non-IID data and adaptive attackers.
3. **Cross-dataset IDS generalization**: train on one dataset, test on another.
4. **Security of LLM agents** against prompt injection through tools and documents. Links to CS-02.
5. **Post-quantum migration studies** for institutional systems.

### Routing signals
- **Route here when** the query mentions attacks, intrusion detection, privacy, differential privacy, encryption, federated learning security, malware, vulnerabilities or prompt injection.
- **Hand off** to CS-01 for core ML; CS-04 for system architecture; PHY-02 for quantum threats.

### Training examples
**Q:** My IDS gets 99.9% accuracy on CIC-IDS2017. Is that publishable?
**A:** Persona CS-05. Probably not on its own: these datasets have duplicates, label issues and easy shortcuts. Deduplicate, split by time, report per-attack recall and false-positive rate, and test cross-dataset generalization (e.g., train on one dataset, test on another).

**Q:** How do I add differential privacy to model training?
**A:** Use DP-SGD with Opacus in PyTorch: clip per-sample gradients, add calibrated noise, and track the privacy budget (epsilon, delta). Report accuracy at several epsilon values to show the trade-off.

---

# Domain: High-Performance Computing (HPC)

**Scope.** Designing, operating, programming and supporting large-scale computing systems for research: clusters, GPUs, parallel storage, scientific software and the people who use them.

**Grand challenges.** Energy-efficient computing; performance portability across CPU and GPU vendors; making HPC accessible to non-specialist researchers; reproducible and FAIR computational science; supporting AI and simulation on the same infrastructure.

**Personas in this domain.** HPC-01 Systems & Infrastructure · HPC-02 Parallel Programming & Performance · HPC-03 AI at Scale · HPC-04 Research Software & Workflows · HPC-05 Research Computing Facilitator.

**Role in this knowledge base.** HPC personas serve every other domain. Each persona's `compute_profile` field tells the HPC personas what that researcher will need.

---

## HPC-01 · HPC Systems & Infrastructure Engineer

```yaml
persona_id: HPC-01
name: HPC Systems & Infrastructure Engineer
domain: High-Performance Computing
subfield: Cluster architecture, scheduling, storage, provisioning, identity
aliases: [HPC administrator, cluster engineer, research computing infrastructure, data centre engineer]
keywords: [Slurm, OpenHPC, Warewulf, provisioning, Lustre, Ceph, BeeGFS, parallel file system, LDAP, FreeIPA, InfiniBand, GPU nodes, monitoring, cooling, energy efficiency]
adjacent_personas: [HPC-05, HPC-02, CS-04, CS-05]
compute_profile: Runs the platform itself; needs monitoring, test partitions and staging environments
output_types: [operational clusters, architecture designs, policies, usage reports]
```

### Profile
Designs, builds and operates the clusters, networks and storage that researchers compute on, and keeps them secure, efficient and available.

### Core research areas
- Cluster architecture and procurement (CPU/GPU mix, interconnect, storage tiers)
- Workload scheduling, fair-share and GPU sharing (e.g., MIG)
- Parallel and object storage (Lustre, Ceph, BeeGFS) and data lifecycle
- Provisioning and configuration management
- Identity and access management
- Monitoring, accounting and usage analytics
- Energy efficiency, cooling and green HPC
- Security hardening of shared research systems

### Typical research questions
- Which architecture gives the most science per budget and per watt?
- Why are jobs waiting so long, and how should the scheduler be tuned?
- Where is the I/O bottleneck?

### Methods & techniques
- Benchmarking (HPL, HPCG, IO500, OSU micro-benchmarks)
- Workload characterization from scheduler logs
- Infrastructure as code; staged upgrades
- Capacity planning and energy measurement

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Workload manager | Slurm | OpenPBS, HTCondor |
| Provisioning | Warewulf (OpenHPC) | xCAT |
| Parallel file system | Lustre | BeeGFS, CephFS |
| Configuration management | Ansible | Salt |
| Identity | FreeIPA | OpenLDAP |
| Monitoring | Prometheus + Grafana | Ganglia |
| Usage accounting | Open XDMoD | Slurm sacct reports |

### Key data & resources
- OpenHPC documentation and recipes; Slurm documentation
- TOP500, Green500 and IO500 lists for comparison
- Public scheduler trace archives

### Suggested research directions
1. **Workload characterization** of the institution's own cluster: who uses what, wait times, utilization. Publishable and directly useful.
2. **Energy-aware scheduling and power capping** with measured savings. Links to CS-04.
3. **GPU sharing strategies** (MIG, MPS, time-slicing) for many small AI jobs. Links to HPC-03.
4. **Tiered storage policies** (scratch, project, archive on Ceph) with data lifecycle rules.
5. **Hybrid HPC–cloud bursting** for peak demand.

### Routing signals
- **Route here when** the query mentions cluster setup, Slurm configuration, nodes, partitions, storage, Lustre/Ceph, OpenHPC, LDAP, provisioning, monitoring or data-centre design.
- **Hand off** to HPC-05 for user-facing support; HPC-02 for application performance; CS-05 for security research.

### Training examples
**Q:** Users complain that GPU jobs wait for days while GPUs sit partly idle. What can we do?
**A:** Persona HPC-01. Analyze sacct data for GPU utilization per job, create a short-job or debug partition, enable GPU sharing (MIG on supported GPUs) for small jobs, set fair-share and job time limits, and publish a usage dashboard (Open XDMoD or Grafana) so users see the policy effect.

**Q:** Should we use Lustre or Ceph for our cluster?
**A:** Lustre is usually better for high-throughput scratch used by parallel jobs; Ceph is flexible for object, block and long-term project storage. Many sites use a fast parallel file system for scratch and Ceph for capacity and archive tiers.

---

## HPC-02 · Parallel Programming & Performance Engineer

```yaml
persona_id: HPC-02
name: Parallel Programming & Performance Engineer
domain: High-Performance Computing
subfield: Parallel algorithms, GPU programming, profiling and optimization
aliases: [performance engineer, parallel computing, HPC developer, GPU programmer]
keywords: [MPI, OpenMP, CUDA, HIP, SYCL, Kokkos, profiling, scaling, speedup, vectorization, memory bandwidth, roofline, mixed precision, performance portability]
adjacent_personas: [HPC-01, HPC-04, MAT-01, PHY-04]
compute_profile: Access to multiple node types for scaling tests; profilers; GPU nodes
output_types: [faster codes, scaling studies, ported applications, performance models]
```

### Profile
Makes scientific codes run faster and scale further on CPUs and GPUs, and helps domain researchers use hardware efficiently.

### Core research areas
- Distributed-memory (MPI) and shared-memory (OpenMP) parallelism
- GPU programming and porting legacy codes
- Performance portability across vendors
- Profiling, roofline analysis and bottleneck diagnosis
- Mixed-precision and communication-avoiding algorithms
- Autotuning and energy-to-solution optimization

### Typical research questions
- Why does my code stop scaling beyond 64 cores?
- Is the code compute-bound or memory-bound?
- Is porting to GPU worth the effort?

### Methods & techniques
- Strong and weak scaling studies
- Profiling and tracing; roofline modeling
- Load balancing and domain decomposition
- Algorithmic restructuring for data locality

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| MPI library | Open MPI | MPICH |
| GPU programming | CUDA | HIP, SYCL |
| Performance portability | Kokkos | RAJA, OpenMP offload |
| Profiling (CPU/MPI) | HPCToolkit | TAU, Score-P |
| GPU profiling | NVIDIA Nsight Systems/Compute (free) | rocprof |
| Micro-benchmarks | OSU Micro-Benchmarks | Intel MPI Benchmarks |

### Key data & resources
- Vendor optimization guides; ECP (Exascale Computing Project) software documentation
- HPC Carpentry and parallel-programming course material

### Suggested research directions
1. **Scaling studies of key local research codes** (e.g., Quantum ESPRESSO, GROMACS) on the institution's hardware, with guidance for users.
2. **GPU porting of a widely used in-house code** with portability layers.
3. **Mixed-precision methods** for faster simulations with controlled error.
4. **Energy-to-solution benchmarking** (not just time-to-solution). Links to HPC-01.
5. **Performance regression testing** in CI. Links to HPC-04.

### Routing signals
- **Route here when** the query mentions MPI, OpenMP, CUDA, parallelization, speedup, scaling, profiling, slow code or GPU porting.
- **Hand off** to HPC-01 for hardware or scheduler limits; HPC-03 for deep-learning training; HPC-04 for build and environment issues.

### Training examples
**Q:** My MPI code gets slower when I add more nodes. What is happening?
**A:** Persona HPC-02. Communication or load imbalance probably dominates. Profile with HPCToolkit or Score-P to see time in MPI calls, check per-rank load balance, measure network performance with OSU benchmarks, and do a strong-scaling plot to find where efficiency drops. Use fewer, larger subdomains or overlap communication with computation.

**Q:** How do I know if GPU porting is worth it?
**A:** Profile first: if a few kernels dominate runtime and are data-parallel with high arithmetic intensity, GPU porting usually pays off. If time is spread across many small serial routines or I/O, gains will be limited.

---

## HPC-03 · AI-at-Scale Engineer

```yaml
persona_id: HPC-03
name: AI-at-Scale Engineer
domain: High-Performance Computing
subfield: Distributed deep learning and inference on clusters
aliases: [ML infrastructure engineer, distributed training, large-scale AI, MLOps on HPC]
keywords: [multi-GPU, multi-node, distributed training, DDP, FSDP, DeepSpeed, mixed precision, checkpointing, data loading, inference serving, NCCL, GPU utilization]
adjacent_personas: [CS-01, CS-02, HPC-01, HPC-02]
compute_profile: Multi-GPU nodes with fast interconnect; fast storage for data loading; long-running jobs with checkpoints
output_types: [scalable training setups, trained models, serving deployments, utilization reports]
```

### Profile
Runs AI training and inference efficiently on shared clusters, bridging ML researchers and HPC infrastructure.

### Core research areas
- Data, tensor and pipeline parallelism; sharded training
- Mixed precision and memory-saving techniques
- Efficient data pipelines and I/O for training
- Checkpointing and fault tolerance on batch schedulers
- LLM and model serving on clusters
- GPU utilization monitoring and optimization

### Typical research questions
- How do I train a model that does not fit on one GPU?
- Why is GPU utilization only 30%?
- How do I run multi-node training under Slurm?

### Methods & techniques
- Distributed data parallel and fully sharded data parallel
- Gradient accumulation, activation checkpointing, BF16/FP16
- Profiling input pipelines and communication
- Containerized environments for reproducibility

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Distributed training | PyTorch DDP/FSDP | DeepSpeed, Megatron-LM |
| Launching | torchrun | Hugging Face Accelerate |
| Training profiling | PyTorch Profiler | Nsight Systems |
| GPU monitoring | NVIDIA DCGM | nvidia-smi, nvtop |
| Inference serving | vLLM | Triton Inference Server |
| Containers on HPC | Apptainer | — |

### Key data & resources
- PyTorch distributed documentation; Hugging Face Accelerate guides
- MLPerf benchmarks for comparison

### Suggested research directions
1. **Efficient fine-tuning services** for researchers (shared QLoRA templates on the cluster). Links to CS-02.
2. **Throughput benchmarking** of local GPUs for common model sizes, published as user guidance.
3. **Data-loading optimization** on parallel and object storage. Links to HPC-01.
4. **Scientific foundation model training** with domain personas (MAT-06, BIO-02).
5. **Cost and energy accounting** per training run.

### Routing signals
- **Route here when** the query mentions multi-GPU, multi-node training, out-of-memory on GPU, FSDP, DeepSpeed, distributed inference or low GPU utilization.
- **Hand off** to CS-01/CS-02 for model design; HPC-01 for node and scheduler configuration; HPC-02 for low-level kernel optimization.

### Training examples
**Q:** How do I run PyTorch training on 2 nodes with 4 GPUs each under Slurm?
**A:** Persona HPC-03. Request `--nodes=2 --gpus-per-node=4` in the job script, set the master address from the first node in `$SLURM_JOB_NODELIST`, and launch with `srun torchrun --nnodes=2 --nproc_per_node=4 --rdzv_backend=c10d --rdzv_endpoint=$MASTER_ADDR:29500 train.py`. Use DDP in the script, save checkpoints regularly and test on one node first.

**Q:** GPU utilization is low during training. What should I check?
**A:** Usually the data pipeline: increase DataLoader workers, enable pinned memory, store data on fast local or parallel storage in an efficient format, and profile with PyTorch Profiler to confirm whether the GPU waits for data.

---

## HPC-04 · Research Software Engineer & Workflow Specialist

```yaml
persona_id: HPC-04
name: Research Software Engineer & Workflow Specialist
domain: High-Performance Computing
subfield: Scientific software, environments, containers, workflows, reproducibility
aliases: [research software engineer, RSE, scientific software engineering, workflow engineer]
keywords: [Spack, EasyBuild, Lmod, modules, conda, Apptainer, Singularity, containers, Snakemake, Nextflow, Parsl, Git, CI, testing, reproducibility, FAIR, documentation]
adjacent_personas: [HPC-02, HPC-05, BIO-01, PHY-03]
compute_profile: Build nodes; container registries; CI runners; shared software stacks
output_types: [software stacks, containers, pipelines, packages, documentation]
```

### Profile
Builds and maintains research software and the environments and workflows that make computational results reproducible and reusable.

### Core research areas
- Software stack management for clusters
- Containers for portable, reproducible environments
- Workflow management systems for multi-step analyses
- Testing, CI and software quality for research code
- FAIR data and software, citation and archiving
- Packaging and documentation

### Typical research questions
- How do I install this software with its dependencies on the cluster?
- How can someone else reproduce my results in two years?
- How do I turn scripts into a reliable pipeline?

### Methods & techniques
- Package managers and module systems
- Containerization and image building
- Workflow definition, versioning and provenance
- Unit and regression testing; continuous integration

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Cluster software builds | Spack | EasyBuild |
| Environment modules | Lmod | Environment Modules |
| User-level environments | conda (Miniforge) | pixi, venv |
| HPC containers | Apptainer | Podman, Charliecloud |
| Workflows | Snakemake | Nextflow, Parsl |
| Version control and CI | Git + GitHub Actions | GitLab CI |
| Archiving with DOI | Zenodo | institutional repository |

### Key data & resources
- The Carpentries and HPC Carpentry lessons; Spack and EasyBuild recipe repositories
- FAIR4RS principles; Software Heritage

### Suggested research directions
1. **A curated, documented software stack** for the institution's main domains (MAT, CHEM, BIO, CS).
2. **Container templates** for common research environments (Python ML, R, bioinformatics).
3. **Reproducibility audits** of published local research code.
4. **Workflow portability** between laptop, cluster and cloud. Links to CS-04.
5. **Research software citation and credit** practices.

### Routing signals
- **Route here when** the query mentions installing software, modules, dependencies, conda, containers, Apptainer, pipelines, reproducibility, Git or CI.
- **Hand off** to HPC-02 for performance tuning; HPC-05 for training and onboarding; BIO-01 for bioinformatics-specific pipelines.

### Training examples
**Q:** Users keep asking to install conflicting Python packages system-wide. What is the better approach?
**A:** Persona HPC-04. Provide core compilers and libraries via Spack and Lmod, let users manage their own Python environments with conda (Miniforge) in project space, and offer Apptainer containers for complex stacks. Document the pattern once and point every request to it.

**Q:** How do I make my analysis reproducible?
**A:** Put code in Git, pin environment versions (environment file or container), define the steps as a workflow (Snakemake or Nextflow), record input data versions, and archive the release on Zenodo with a DOI.

---

## HPC-05 · Research Computing Facilitator

```yaml
persona_id: HPC-05
name: Research Computing Facilitator
domain: High-Performance Computing
subfield: User support, onboarding, training, research consultation
aliases: [research computing facilitator, HPC support, user support, research IT liaison, cyberinfrastructure facilitator]
keywords: [onboarding, Open OnDemand, JupyterHub, user support, tickets, documentation, training, Carpentries, allocation, consultation, chatbot, knowledge base]
adjacent_personas: [HPC-01, HPC-04, CS-02, all domain personas]
compute_profile: Web portals, documentation platforms, ticketing; small allocations for demos and training
output_types: [onboarded users, documentation, training courses, support metrics, consultations]
```

### Profile
Connects researchers to computing resources: understands their science, translates needs into technical solutions, and teaches them to compute effectively. This persona is the main human user of this knowledge base.

### Core research areas
- Onboarding and lowering barriers to HPC
- Web portals for interactive computing
- Training programs and lesson design
- Support operations: tickets, documentation, FAQs, chatbots
- Measuring research-computing impact (publications, grants, users)
- Allocation policies and research consultations

### Typical research questions
- What does this researcher actually need, and which resource fits?
- Which questions keep coming back, and how can we answer them once?
- How do we show the value of research computing to leadership?

### Methods & techniques
- Intake interviews mapped to personas (use Section 3 routing)
- Documentation-first support; self-service portals
- Hands-on workshops; office hours
- Support analytics from tickets

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| Web portal for HPC | Open OnDemand | JupyterHub |
| Ticketing | Zammad | osTicket, GLPI |
| Documentation site | MkDocs (Material theme) | Sphinx |
| Training material | The Carpentries / HPC Carpentry | — |
| Usage and impact reporting | Open XDMoD | custom Grafana dashboards |
| Support chatbot over docs | RAG stack from CS-02 (LlamaIndex + FAISS + local model via Ollama) | — |

### Key data & resources
- This knowledge base; institutional HPC documentation
- Campus Research Computing Consortium (CaRCC) and Carpentries community resources

### Suggested research directions
1. **Persona-based intake**: classify every new user with this KB and attach a starter kit (tools, modules, example job script) per persona.
2. **RAG support assistant** grounded in local documentation and this KB, measured on real ticket questions. Links to CS-02.
3. **Ticket analytics** to find the top recurring issues and fix them in documentation.
4. **Impact tracking**: link usage to publications and grants.
5. **Domain-specific training tracks** (HPC for chemists, for biologists, for ML).

### Routing signals
- **Route here when** the query mentions getting an account, first job, how to use the cluster, Open OnDemand, training, documentation, support requests or "which resource should I use?".
- **Hand off** to HPC-01 for system faults; HPC-04 for software installs; the relevant domain persona for science questions.

### Training examples
**Q:** A new chemistry PhD student asks how to start using the cluster. What should the facilitator do?
**A:** Persona HPC-05. Classify the student (likely CHEM-02 or CHEM-01), give them the account and access steps, an Open OnDemand login for a first interactive session, the relevant software modules (e.g., Psi4, xtb, ORCA if licensed), a template Slurm job script for their code, and a link to the next intro workshop.

**Q:** How can we reduce repeated support tickets?
**A:** Tag tickets by persona and topic for one month, list the top 10 recurring issues, write a short documentation page for each, link them from the portal and auto-replies, and feed them into a RAG support assistant. Re-measure ticket volume after another month.

---

# Appendix A · Research Flow Guide

Use this guide to move a researcher in a clear direction. For any persona, the assistant should identify which stage the researcher is in and give the stage-specific help below.

| Stage | Researcher's need | What the knowledge base should provide |
|---|---|---|
| 1. Orientation | "What is my area and what is hot in it?" | Persona match, Core research areas, Suggested research directions |
| 2. Scoping | "What question should I pursue?" | 2–3 specific research questions from Typical research questions, adapted to their resources |
| 3. Literature | "What has been done?" | Search keywords from the persona `keywords`; key venues; suggested review approach |
| 4. Data | "Where do I get data?" | Key data & resources; data-collection advice; FAIR practices (HPC-04) |
| 5. Methods | "How do I do it?" | Methods & techniques; one primary free tool per use case with alternatives |
| 6. Compute | "Where do I run it?" | `compute_profile` → HPC-05 for access, HPC-04 for environment, HPC-02/HPC-03 for scaling |
| 7. Analysis & validation | "Is my result right?" | Validation steps from Training examples; baselines; uncertainty; reproducibility |
| 8. Collaboration | "Who should I work with?" | `adjacent_personas` and Section 4 bridges |
| 9. Dissemination | "How do I publish and share?" | Reproducible release (Git, container, Zenodo DOI), open data, suitable venues |

**Rule of thumb for direction-setting:** recommend the direction that (a) matches the researcher's available resources, (b) has open data or free tools, and (c) sits on a cross-domain bridge, since these produce faster, more original results.

---

# Appendix B · Answer Template for the Assistant

When a researcher asks a question, the assistant using this knowledge base should answer in this order:

1. **Persona identified:** `<ID> · <Name>` (plus collaborating persona IDs if relevant).
2. **Direct answer:** the specific answer to the question.
3. **Recommended next steps:** 2–4 concrete actions, each starting with a verb.
4. **Tools:** one primary free tool per needed use case, with alternatives.
5. **Data or resources:** the most relevant 1–3 sources.
6. **Research direction suggestion:** one direction from the persona's list that fits the question.
7. **Compute note (if relevant):** what to request and which HPC persona to contact.

**Example**

> **Persona identified:** BIO-05 · Ecologist, Evolutionary & Agricultural Biologist (with CS-03)
> **Direct answer:** Your model is learning background cues from lab images, so it fails in the field.
> **Next steps:** Collect 300+ field images; annotate in CVAT; fine-tune a pretrained backbone with strong augmentation; test on farms not used in training.
> **Tools:** PyTorch + timm (alternatives: torchvision); CVAT (alternative: Label Studio).
> **Data:** PlantVillage for pretraining only; your own field images for evaluation.
> **Direction:** Field-ready plant disease detection with uncertainty-gated predictions.
> **Compute:** One GPU is enough; free Kaggle GPUs work for prototyping.

---

# Appendix C · Template for Adding a New Persona

Copy this block, fill it in, then add the persona to Section 2 (Index) and Section 3 (Routing Map).

````markdown
## <DOMAIN>-<NN> · <Persona Name>

```yaml
persona_id: <DOMAIN>-<NN>
name: <Persona Name>
domain: <Domain>
subfield: <Subfield>
aliases: [<alias 1>, <alias 2>]
keywords: [<keyword 1>, <keyword 2>, <keyword 3>]
adjacent_personas: [<ID>, <ID>]
compute_profile: <typical compute needs>
output_types: [<output 1>, <output 2>]
```

### Profile
<One paragraph.>

### Core research areas
- <area>

### Typical research questions
- <question>

### Methods & techniques
- <method>

### Recommended tools (free)
| Use case | Primary | Alternatives |
|---|---|---|
| <use case> | <tool> | <tools> |

### Key data & resources
- <resource>

### Suggested research directions
1. **<Direction>.** <Why and first step.>

### Routing signals
- **Route here when** <triggers>.
- **Hand off** to <ID> for <reason>.

### Training examples
**Q:** <question>
**A:** Persona <ID>. <answer>
````

**Suggested future personas:** Mathematics & Statistics (MATH), Earth & Environmental Science (EARTH: geology, mining, hydrology, climate modeling), Engineering (ENG: civil, electrical, mechanical), Health & Medical Sciences (MED), Data Science & Learning Analytics (DS), Social Sciences (SOC).

---

*End of knowledge base v1.0.*
