create_clock -name clk -period 8 [get_ports CLK]
create_generated_clock -name a -source [get_pins U0/Q] -divide_by 2 [get_pins U0/Q]
create_generated_clock -name b -source [get_pins U0/Q] -master_clock a -divide_by 2 [get_pins U0/D]
create_generated_clock -name a -source [get_pins U0/D] -master_clock b -divide_by 2 [get_pins U0/D]
set_input_delay 1 -clock clk [get_ports MISSING*] # empty broad query @expect 1
