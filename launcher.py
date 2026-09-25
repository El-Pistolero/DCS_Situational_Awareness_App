"""Entry point for the packaged DCS-SA.exe (see dcs-sa.spec)."""

from dcs_sa.desktop import main

if __name__ == "__main__":
    raise SystemExit(main())
