"""audit_zranges.py — mesh-level evidence: shell z-ranges/bboxes for the
collision pairs (tray bosses vs plate skirt; skirt behind USB slot)."""
import numpy as np
import part_tray, part_plate
from audit_probe import shells_of

tray = part_tray.build()[0][1]
plate = part_plate.build()[0][1]

print("TRAY shells near corner (+39,+39):")
for z0, z1, (xa, xb, ya, yb), nt in shells_of(tray):
    if xa > 33 and ya > 33 and xb < 45 and yb < 45:   # boss-ish bbox at that corner
        print(f"  z {z0:.2f}..{z1:.2f}  x {xa:.2f}..{xb:.2f}  y {ya:.2f}..{yb:.2f}  tris={nt}")

print("PLATE shells:")
for z0, z1, (xa, xb, ya, yb), nt in shells_of(plate):
    print(f"  z {z0:.2f}..{z1:.2f}  x {xa:.2f}..{xb:.2f}  y {ya:.2f}..{yb:.2f}  tris={nt}")

# skirt = the shell spanning z 7.5..14.2 with ~86.5 bbox
V, F = plate._np()
print("\nplate vertex z-range:", V[:, 2].min(), V[:, 2].max())
