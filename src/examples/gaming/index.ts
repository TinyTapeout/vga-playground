import hvsync_generator_v from '../common/hvsync_generator.v?raw';
import project_v from './project.v?raw';

export const gaming = {
  name: 'Gaming',
  author: 'Uri Shaked',
  topModule: 'tt_um_gaming_pmod_demo',
  sources: {
    'project.v': project_v,
    'hvsync_generator.v': hvsync_generator_v,
  },
};
