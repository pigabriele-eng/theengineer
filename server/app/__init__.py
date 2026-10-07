"""The Engineer's server."""
import os

# numpy's maths library (OpenBLAS) starts one thread per CPU it sees for each matrix calculation. The hosted server
# sees the host's CPUs but may use a tenth of one, so those threads only take turns at that tenth, and every request
# beside them waits: the event page's driver guess took 6 to 10 s that way, 1.2 s with one thread. One thread each,
# unless the environment says otherwise. Set here, before anything imports numpy.
for _name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_name, "1")
