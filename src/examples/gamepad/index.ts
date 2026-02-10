import gamepad_pmod_v from '../common/gamepad_pmod.v?raw';
import hvsync_generator_v from '../common/hvsync_generator.v?raw';
import project_v from './project.v?raw';

export const gamepad = {
  name: 'Gamepad',
  author: 'Uri Shaked',
  sources: {
    'project.v': project_v,
    'gamepad_pmod.v': gamepad_pmod_v,
    'hvsync_generator.v': hvsync_generator_v,
  },
};
