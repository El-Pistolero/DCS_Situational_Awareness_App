# PyInstaller spec for the Windows desktop build:  pyinstaller dcs-sa.spec
# Produces dist/DCS-SA.exe - a single windowed executable.

block_cipher = None

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    datas=[
        ("dcs_sa/web", "dcs_sa/web"),
        ("dcs_sa/data", "dcs_sa/data"),
        ("dcs-scripts/DCS-SA-Export.lua", "dcs-scripts"),
        ("dcs-scripts/DCS-SA-Hook.lua", "dcs-scripts"),
        ("samples/sample_sortie.acmi", "samples"),
        ("samples/sample_strike.acmi", "samples"),
        ("packaging/dcs-sa.ico", "packaging"),
    ],
    hiddenimports=["webview", "clr_loader", "pythonnet"],
    excludes=["tkinter", "unittest", "pydoc"],
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="DCS-SA",
    console=False,
    icon="packaging/dcs-sa.ico",
    upx=False,
)
