import { downloadZip } from 'client-zip';
import { Project } from './examples/Project';

const infoYaml = (topModule: string) =>
  `
# Tiny Tapeout project information
project:
  title:        ""      # Project title
  author:       ""      # Your name
  discord:      ""      # Your discord username, for communication and automatically assigning you a Tapeout role (optional)
  description:  ""      # One line description of what your project does
  language:     "Verilog" # other examples include SystemVerilog, Amaranth, VHDL, etc
  clock_hz:     25175000       # Clock frequency in Hz (or 0 if not applicable)

  # How many tiles your design occupies? A single tile is about 167x108 uM.
  tiles: "1x1"          # Valid values: 1x1, 1x2, 2x2, 3x2, 4x2, 6x2 or 8x2

  # Your top module name must start with "tt_um_". Make it unique by including your github username:
  top_module:  "${topModule}"
  
  # List your project's source files here. Source files must be in ./src and you must list each source file separately, one per line:
  source_files:        
    - "project.v"

# The pinout of your project. Leave unused pins blank. DO NOT delete or add any pins.
pinout:
  # Inputs
  ui[0]: ""
  ui[1]: ""
  ui[2]: ""
  ui[3]: ""
  ui[4]: ""
  ui[5]: ""
  ui[6]: ""
  ui[7]: ""

  # Outputs
  uo[0]: "R1"
  uo[1]: "G1"
  uo[2]: "B1"
  uo[3]: "VSync"
  uo[4]: "R0"
  uo[5]: "G0"
  uo[6]: "B0"
  uo[7]: "HSync"

  # Bidirectional pins
  uio[0]: ""
  uio[1]: ""
  uio[2]: ""
  uio[3]: ""
  uio[4]: ""
  uio[5]: ""
  uio[6]: ""
  uio[7]: ""

# Do not change!
yaml_version: 6
`;

export function downloadURL(url: string, filename: string) {
  const link: HTMLAnchorElement = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function exportProject(project: Project) {
  const currentTime = new Date();
  const archive = [
    {
      name: 'info.yaml',
      date: currentTime,
      input: infoYaml(project.topModule),
    },
    ...Object.entries(project.sources).map(([name, content]) => ({
      name: 'src/' + name,
      date: currentTime,
      input: content,
    })),
  ];

  // get the ZIP stream in a Blob
  const blob = await downloadZip(archive).blob();
  const filename = project.topModule.replace(/[/<>:"\\|?*]/g, '_').replace(/(\.[^.]+)?$/, '.zip');
  downloadURL(URL.createObjectURL(blob), filename.length > 4 ? filename : 'project.zip');
}
