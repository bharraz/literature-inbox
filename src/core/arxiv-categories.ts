/**
 * arXiv's category taxonomy, as a static list rather than a live fetch.
 *
 * arXiv publishes this taxonomy on a web page, not a JSON endpoint — there is
 * no official API to query it, and scraping HTML for a dropdown's contents is
 * exactly the kind of fragile, unofficial dependency the rest of this plugin
 * avoids (see the OpenAlex/arXiv non-negotiables). The taxonomy itself is
 * long-stable — new categories are added a few times a decade — so a bundled
 * list is a fine trade: it needs no network call and cannot go stale in any
 * way that matters. `CUSTOM_ARXIV_CATEGORY` is the escape hatch for the rare
 * category not listed here, or a new one added after this file was written.
 */

export interface ArxivCategory {
  code: string;
  label: string;
}

/** Sentinel dropdown value meaning "let me type the code myself". */
export const CUSTOM_ARXIV_CATEGORY = "__custom__";

export const ARXIV_CATEGORIES: ArxivCategory[] = [
  // Computer Science
  { code: "cs.AI", label: "cs.AI — Artificial Intelligence" },
  { code: "cs.AR", label: "cs.AR — Hardware Architecture" },
  { code: "cs.CC", label: "cs.CC — Computational Complexity" },
  { code: "cs.CE", label: "cs.CE — Computational Engineering, Finance, and Science" },
  { code: "cs.CG", label: "cs.CG — Computational Geometry" },
  { code: "cs.CL", label: "cs.CL — Computation and Language" },
  { code: "cs.CR", label: "cs.CR — Cryptography and Security" },
  { code: "cs.CV", label: "cs.CV — Computer Vision and Pattern Recognition" },
  { code: "cs.CY", label: "cs.CY — Computers and Society" },
  { code: "cs.DB", label: "cs.DB — Databases" },
  { code: "cs.DC", label: "cs.DC — Distributed, Parallel, and Cluster Computing" },
  { code: "cs.DL", label: "cs.DL — Digital Libraries" },
  { code: "cs.DM", label: "cs.DM — Discrete Mathematics" },
  { code: "cs.DS", label: "cs.DS — Data Structures and Algorithms" },
  { code: "cs.ET", label: "cs.ET — Emerging Technologies" },
  { code: "cs.FL", label: "cs.FL — Formal Languages and Automata Theory" },
  { code: "cs.GT", label: "cs.GT — Computer Science and Game Theory" },
  { code: "cs.HC", label: "cs.HC — Human-Computer Interaction" },
  { code: "cs.IR", label: "cs.IR — Information Retrieval" },
  { code: "cs.IT", label: "cs.IT — Information Theory" },
  { code: "cs.LG", label: "cs.LG — Machine Learning" },
  { code: "cs.LO", label: "cs.LO — Logic in Computer Science" },
  { code: "cs.MA", label: "cs.MA — Multiagent Systems" },
  { code: "cs.MM", label: "cs.MM — Multimedia" },
  { code: "cs.MS", label: "cs.MS — Mathematical Software" },
  { code: "cs.NA", label: "cs.NA — Numerical Analysis" },
  { code: "cs.NE", label: "cs.NE — Neural and Evolutionary Computing" },
  { code: "cs.NI", label: "cs.NI — Networking and Internet Architecture" },
  { code: "cs.OS", label: "cs.OS — Operating Systems" },
  { code: "cs.PF", label: "cs.PF — Performance" },
  { code: "cs.PL", label: "cs.PL — Programming Languages" },
  { code: "cs.RO", label: "cs.RO — Robotics" },
  { code: "cs.SC", label: "cs.SC — Symbolic Computation" },
  { code: "cs.SD", label: "cs.SD — Sound" },
  { code: "cs.SE", label: "cs.SE — Software Engineering" },
  { code: "cs.SI", label: "cs.SI — Social and Information Networks" },
  { code: "cs.SY", label: "cs.SY — Systems and Control" },

  // Economics
  { code: "econ.EM", label: "econ.EM — Econometrics" },
  { code: "econ.GN", label: "econ.GN — General Economics" },
  { code: "econ.TH", label: "econ.TH — Theoretical Economics" },

  // Electrical Engineering and Systems Science
  { code: "eess.AS", label: "eess.AS — Audio and Speech Processing" },
  { code: "eess.IV", label: "eess.IV — Image and Video Processing" },
  { code: "eess.SP", label: "eess.SP — Signal Processing" },
  { code: "eess.SY", label: "eess.SY — Systems and Control" },

  // Mathematics
  { code: "math.AG", label: "math.AG — Algebraic Geometry" },
  { code: "math.AT", label: "math.AT — Algebraic Topology" },
  { code: "math.AP", label: "math.AP — Analysis of PDEs" },
  { code: "math.CA", label: "math.CA — Classical Analysis and ODEs" },
  { code: "math.CO", label: "math.CO — Combinatorics" },
  { code: "math.CT", label: "math.CT — Category Theory" },
  { code: "math.CV", label: "math.CV — Complex Variables" },
  { code: "math.DG", label: "math.DG — Differential Geometry" },
  { code: "math.DS", label: "math.DS — Dynamical Systems" },
  { code: "math.FA", label: "math.FA — Functional Analysis" },
  { code: "math.GN", label: "math.GN — General Topology" },
  { code: "math.GR", label: "math.GR — Group Theory" },
  { code: "math.GT", label: "math.GT — Geometric Topology" },
  { code: "math.HO", label: "math.HO — History and Overview" },
  { code: "math.LO", label: "math.LO — Logic" },
  { code: "math.MP", label: "math.MP — Mathematical Physics" },
  { code: "math.NA", label: "math.NA — Numerical Analysis" },
  { code: "math.NT", label: "math.NT — Number Theory" },
  { code: "math.OA", label: "math.OA — Operator Algebras" },
  { code: "math.OC", label: "math.OC — Optimization and Control" },
  { code: "math.PR", label: "math.PR — Probability" },
  { code: "math.QA", label: "math.QA — Quantum Algebra" },
  { code: "math.RA", label: "math.RA — Rings and Algebras" },
  { code: "math.RT", label: "math.RT — Representation Theory" },
  { code: "math.SG", label: "math.SG — Symplectic Geometry" },
  { code: "math.SP", label: "math.SP — Spectral Theory" },
  { code: "math.ST", label: "math.ST — Statistics Theory" },

  // Physics — grouped
  { code: "astro-ph.CO", label: "astro-ph.CO — Cosmology and Nongalactic Astrophysics" },
  { code: "astro-ph.EP", label: "astro-ph.EP — Earth and Planetary Astrophysics" },
  { code: "astro-ph.GA", label: "astro-ph.GA — Astrophysics of Galaxies" },
  { code: "astro-ph.HE", label: "astro-ph.HE — High Energy Astrophysical Phenomena" },
  { code: "astro-ph.IM", label: "astro-ph.IM — Instrumentation and Methods for Astrophysics" },
  { code: "astro-ph.SR", label: "astro-ph.SR — Solar and Stellar Astrophysics" },
  { code: "cond-mat.dis-nn", label: "cond-mat.dis-nn — Disordered Systems and Neural Networks" },
  { code: "cond-mat.mes-hall", label: "cond-mat.mes-hall — Mesoscale and Nanoscale Physics" },
  { code: "cond-mat.mtrl-sci", label: "cond-mat.mtrl-sci — Materials Science" },
  { code: "cond-mat.quant-gas", label: "cond-mat.quant-gas — Quantum Gases" },
  { code: "cond-mat.soft", label: "cond-mat.soft — Soft Condensed Matter" },
  { code: "cond-mat.stat-mech", label: "cond-mat.stat-mech — Statistical Mechanics" },
  { code: "cond-mat.str-el", label: "cond-mat.str-el — Strongly Correlated Electrons" },
  { code: "cond-mat.supr-con", label: "cond-mat.supr-con — Superconductivity" },
  { code: "gr-qc", label: "gr-qc — General Relativity and Quantum Cosmology" },
  { code: "hep-ex", label: "hep-ex — High Energy Physics - Experiment" },
  { code: "hep-lat", label: "hep-lat — High Energy Physics - Lattice" },
  { code: "hep-ph", label: "hep-ph — High Energy Physics - Phenomenology" },
  { code: "hep-th", label: "hep-th — High Energy Physics - Theory" },
  { code: "math-ph", label: "math-ph — Mathematical Physics" },
  { code: "nlin.CD", label: "nlin.CD — Chaotic Dynamics" },
  { code: "nucl-ex", label: "nucl-ex — Nuclear Experiment" },
  { code: "nucl-th", label: "nucl-th — Nuclear Theory" },
  { code: "physics.acc-ph", label: "physics.acc-ph — Accelerator Physics" },
  { code: "physics.app-ph", label: "physics.app-ph — Applied Physics" },
  { code: "physics.atom-ph", label: "physics.atom-ph — Atomic Physics" },
  { code: "physics.bio-ph", label: "physics.bio-ph — Biological Physics" },
  { code: "physics.chem-ph", label: "physics.chem-ph — Chemical Physics" },
  { code: "physics.comp-ph", label: "physics.comp-ph — Computational Physics" },
  { code: "physics.data-an", label: "physics.data-an — Data Analysis, Statistics and Probability" },
  { code: "physics.flu-dyn", label: "physics.flu-dyn — Fluid Dynamics" },
  { code: "physics.gen-ph", label: "physics.gen-ph — General Physics" },
  { code: "physics.ins-det", label: "physics.ins-det — Instrumentation and Detectors" },
  { code: "physics.med-ph", label: "physics.med-ph — Medical Physics" },
  { code: "physics.optics", label: "physics.optics — Optics" },
  { code: "physics.plasm-ph", label: "physics.plasm-ph — Plasma Physics" },
  { code: "physics.soc-ph", label: "physics.soc-ph — Physics and Society" },
  { code: "quant-ph", label: "quant-ph — Quantum Physics" },

  // Quantitative Biology
  { code: "q-bio.BM", label: "q-bio.BM — Biomolecules" },
  { code: "q-bio.CB", label: "q-bio.CB — Cell Behavior" },
  { code: "q-bio.GN", label: "q-bio.GN — Genomics" },
  { code: "q-bio.MN", label: "q-bio.MN — Molecular Networks" },
  { code: "q-bio.NC", label: "q-bio.NC — Neurons and Cognition" },
  { code: "q-bio.PE", label: "q-bio.PE — Populations and Evolution" },
  { code: "q-bio.QM", label: "q-bio.QM — Quantitative Methods" },
  { code: "q-bio.TO", label: "q-bio.TO — Tissues and Organs" },

  // Quantitative Finance
  { code: "q-fin.CP", label: "q-fin.CP — Computational Finance" },
  { code: "q-fin.EC", label: "q-fin.EC — Economics" },
  { code: "q-fin.GN", label: "q-fin.GN — General Finance" },
  { code: "q-fin.MF", label: "q-fin.MF — Mathematical Finance" },
  { code: "q-fin.PM", label: "q-fin.PM — Portfolio Management" },
  { code: "q-fin.PR", label: "q-fin.PR — Pricing of Securities" },
  { code: "q-fin.RM", label: "q-fin.RM — Risk Management" },
  { code: "q-fin.ST", label: "q-fin.ST — Statistical Finance" },
  { code: "q-fin.TR", label: "q-fin.TR — Trading and Market Microstructure" },

  // Statistics
  { code: "stat.AP", label: "stat.AP — Applications" },
  { code: "stat.CO", label: "stat.CO — Computation" },
  { code: "stat.ME", label: "stat.ME — Methodology" },
  { code: "stat.ML", label: "stat.ML — Machine Learning" },
  { code: "stat.OT", label: "stat.OT — Other Statistics" },
  { code: "stat.TH", label: "stat.TH — Statistics Theory" },
];

/** Whether *code* is one of the bundled categories (case-insensitive, as
 * arXiv category codes are conventionally lowercase but easy to mistype). */
export function isKnownArxivCategory(code: string): boolean {
  const trimmed = code.trim().toLowerCase();
  return ARXIV_CATEGORIES.some((c) => c.code.toLowerCase() === trimmed);
}
