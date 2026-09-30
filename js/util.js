// Small helpers shared by the page and the worker

const mod = (x, m) => ((x % m) + m) % m;  // modulo that stays positive, like Python's %
