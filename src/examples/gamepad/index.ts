import hvsync_generator_v from '../common/hvsync_generator.v?raw';
import project_v from './project.v?raw';
import gamepad_pmod_v from '../common/gamepad_pmod.v?raw';

export const gamepad = {
  name: 'Gamepad',
  author: 'Uri Shaked',
  topModule: 'tt_um_vga_example',
  sources: {
    'project.v': project_v + '\n\n' + gamepad_pmod_v,
    'hvsync_generator.v': hvsync_generator_v,
  },
};
