// SPDX-License-Identifier: Apache 2.0
// Copyright (C) 2024, Tiny Tapeout LTD

`default_nettype none

module tt_fpga_top (
    input  wire [7:0] ui_in,
    output wire [7:0] uo_out,
    inout  wire [7:0] uio,
    input  wire       clk,
    input  wire       rst_n
);
  wire [7:0] uio_in;
  wire [7:0] uio_out;
  wire [7:0] uio_oe;

  SB_IO #(
      .PIN_TYPE(6'b1010_01)
  ) uio_pin[7:0] (
      .PACKAGE_PIN(uio),
      .OUTPUT_ENABLE(uio_oe),
      .D_OUT_0(uio_out),
      .D_IN_0(uio_in),
  );

  __tt_um_placeholder user_project (
      .ui_in(ui_in),
      .uo_out(uo_out),
      .uio_in(uio_in),
      .uio_out(uio_out),
      .uio_oe(uio_oe),
      .ena(1'b1),
      .clk(clk),
      .rst_n(rst_n)
  );

endmodule
